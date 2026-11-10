'use strict';
const fs = require('fs');
const path = require('path');
const { estimateTakerFeeDollars } = require('./kalshi-economics');

class MLPaperHoldRuntime {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.startingCash = Number(options.startingCash ?? 100);
    this.specialistStartingCash = Number(options.specialistStartingCash ?? this.startingCash);
    this.minEdge = Number(options.minEdge ?? 0.05);
    this.maxContracts = Math.max(1, Math.floor(Number(options.maxContracts ?? 1)));
    this.maxExposure = Number(options.maxExposure ?? 10);
    this.feeRate = Number(options.feeRate ?? 0.07);
    this.statePath = options.statePath || path.join(__dirname, '..', 'data', 'ml-paper-state.json');
    this.now = options.now || Date.now;
    this.cash = this.startingCash;
    this.realizedPnl = 0;
    this.positions = [];
    this.trades = [];
    this.enteredTickers = new Set(); // specialist:ticker keys in v2; legacy ticker keys are migrated on load
    this.specialistCash = { EARLY:this.specialistStartingCash, LATE:this.specialistStartingCash, FINAL:this.specialistStartingCash, GLOBAL:this.specialistStartingCash, RESIDUAL:this.specialistStartingCash };
    this.specialistRealizedPnl = { EARLY:0, LATE:0, FINAL:0, GLOBAL:0, RESIDUAL:0 };
    this.marketsEvaluated = { EARLY:new Set(), LATE:new Set(), FINAL:new Set(), GLOBAL:new Set(), RESIDUAL:new Set() };
    this.snapshotEvaluations = { EARLY:0, LATE:0, FINAL:0, GLOBAL:0, RESIDUAL:0 };
    this.specialistNoTrades = { EARLY:0, LATE:0, FINAL:0, GLOBAL:0, RESIDUAL:0 };
    this.specialistDuplicateSkips = { EARLY:0, LATE:0, FINAL:0, GLOBAL:0, RESIDUAL:0 };
    this.opportunitiesEvaluated = 0;
    this.noTrades = 0;
    this.duplicateSkips = 0;
    this.lastDecision = null;
    this._load();
  }
  _specialistName(x) { const n=String(x || 'GLOBAL').toUpperCase(); return ['EARLY','LATE','FINAL','GLOBAL','RESIDUAL'].includes(n)?n:'GLOBAL'; }
  _entryKey(ticker, specialist) { return `${this._specialistName(specialist)}:${ticker}`; }
  _ensureSpecialist(name) { const n=this._specialistName(name); if(!Number.isFinite(this.specialistCash[n])) this.specialistCash[n]=this.specialistStartingCash; if(!Number.isFinite(this.specialistRealizedPnl[n])) this.specialistRealizedPnl[n]=0; if(!this.marketsEvaluated[n]) this.marketsEvaluated[n]=new Set(); if(!Number.isFinite(this.snapshotEvaluations[n])) this.snapshotEvaluations[n]=0; if(!Number.isFinite(this.specialistNoTrades[n])) this.specialistNoTrades[n]=0; if(!Number.isFinite(this.specialistDuplicateSkips[n])) this.specialistDuplicateSkips[n]=0; return n; }
  _load() {
    try {
      if (!this.statePath || !fs.existsSync(this.statePath)) return;
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (Number.isFinite(s.cash)) this.cash = s.cash;
      if (Number.isFinite(s.realizedPnl)) this.realizedPnl = s.realizedPnl;
      this.positions = Array.isArray(s.positions) ? s.positions : [];
      this.trades = Array.isArray(s.trades) ? s.trades : [];
      this.opportunitiesEvaluated = Number(s.opportunitiesEvaluated) || 0;
      this.noTrades = Number(s.noTrades) || 0;
      this.duplicateSkips = Number(s.duplicateSkips) || 0;
      this.lastDecision = s.lastDecision || null;
      if (s.specialistCash) Object.assign(this.specialistCash,s.specialistCash);
      if (s.specialistRealizedPnl) Object.assign(this.specialistRealizedPnl,s.specialistRealizedPnl);
      if (s.snapshotEvaluations) Object.assign(this.snapshotEvaluations,s.snapshotEvaluations);
      if (s.specialistNoTrades) Object.assign(this.specialistNoTrades,s.specialistNoTrades);
      if (s.specialistDuplicateSkips) Object.assign(this.specialistDuplicateSkips,s.specialistDuplicateSkips);
      for (const [k,v] of Object.entries(s.marketsEvaluated||{})) this.marketsEvaluated[this._ensureSpecialist(k)]=new Set(Array.isArray(v)?v:[]);
      // v1 migration: reconstruct specialist-aware entry guards from durable positions/trades.
      for (const p of this.positions) this.enteredTickers.add(this._entryKey(p.ticker,p.activeSpecialist||p.model));
      for (const t of this.trades) this.enteredTickers.add(this._entryKey(t.ticker,t.activeSpecialist||t.model));
      for (const key of (s.enteredTickers || [])) if (String(key).includes(':')) this.enteredTickers.add(key);
      if (!s.specialistCash) {
        // Historical v1 accounting remains in aggregate cash/P&L; new independent bankrolls start fresh.
        for (const n of Object.keys(this.specialistCash)) this.specialistCash[n]=this.specialistStartingCash;
      }
    } catch (e) { console.warn(`[MLPaper] state restore skipped: ${e.message}`); }
  }
  save() {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    const marketsEvaluated=Object.fromEntries(Object.entries(this.marketsEvaluated).map(([k,v])=>[k,[...v]]));
    fs.writeFileSync(tmp, JSON.stringify({ version:2, cash:this.cash, realizedPnl:this.realizedPnl, specialistCash:this.specialistCash, specialistRealizedPnl:this.specialistRealizedPnl, positions:this.positions, trades:this.trades.slice(-500), enteredTickers:[...this.enteredTickers], opportunitiesEvaluated:this.opportunitiesEvaluated, marketsEvaluated, snapshotEvaluations:this.snapshotEvaluations, noTrades:this.noTrades, specialistNoTrades:this.specialistNoTrades, duplicateSkips:this.duplicateSkips, specialistDuplicateSkips:this.specialistDuplicateSkips, lastDecision:this.lastDecision }, null, 2));
    fs.renameSync(tmp, this.statePath);
  }
  _decision(market, prediction) {
    const yesAsk = Number(market?.yesAsk), noAsk = Number(market?.noAsk);
    const pYes = Number(prediction?.selectedProbability);
    const model = prediction?.model || prediction?.regime || 'GLOBAL';
    const timeRemaining = Math.max(0, Number(prediction?.timeRemainingMs ?? ((market?.closeTime || 0) - this.now())));
    const base = { ticker:market?.ticker, timestamp:this.now(), model, activeSpecialist:prediction?.regime || null, modelYesProbability:pYes, modelNoProbability:Number.isFinite(pYes)?1-pYes:null, kalshiProbability:Number(prediction?.kalshiYesProbability), timeRemainingMs:timeRemaining, globalProbability:prediction?.globalProbability ?? null, residualProbability:prediction?.residualProbability ?? null };
    if (!this.enabled) return {...base, action:'NO TRADE', reason:'ml_paper_disabled'};
    if (!market?.ticker || !Number.isFinite(pYes) || pYes < 0 || pYes > 1) return {...base, action:'NO TRADE', reason:'prediction_unavailable'};
    if (!(yesAsk > 0 && yesAsk < 1 && noAsk > 0 && noAsk < 1)) return {...base, action:'NO TRADE', reason:'executable_ask_unavailable'};
    const feeYes = estimateTakerFeeDollars(yesAsk,1,this.feeRate,market.feeMultiplier ?? 1);
    const feeNo = estimateTakerFeeDollars(noAsk,1,this.feeRate,market.feeMultiplier ?? 1);
    const yesRaw = pYes-yesAsk, noRaw=(1-pYes)-noAsk;
    const yesEdge=yesRaw-feeYes, noEdge=noRaw-feeNo;
    const side = yesEdge >= noEdge ? 'yes' : 'no';
    const ask = side==='yes'?yesAsk:noAsk, rawEdge=side==='yes'?yesRaw:noRaw, feePerContract=side==='yes'?feeYes:feeNo, afterFeeEdge=side==='yes'?yesEdge:noEdge;
    return {...base, side, executableAsk:ask, rawEdge, estimatedFeePerContract:feePerContract, afterFeeEdge, action:afterFeeEdge>=this.minEdge?`BUY ${side.toUpperCase()}`:'NO TRADE', reason:afterFeeEdge>=this.minEdge?'edge_pass':'below_min_after_fee_edge'};
  }
  evaluate(market, prediction) {
    this.opportunitiesEvaluated++;
    let d=this._decision(market,prediction);
    const specialist=this._ensureSpecialist(d.activeSpecialist||d.model);
    this.snapshotEvaluations[specialist]++;
    if(market?.ticker) this.marketsEvaluated[specialist].add(market.ticker);
    const entryKey=this._entryKey(market?.ticker,specialist);
    if (this.enteredTickers.has(entryKey)) { this.duplicateSkips++; this.specialistDuplicateSkips[specialist]++; this.lastDecision={...d,action:'NO TRADE',reason:'duplicate_ticker'}; this.save(); return this.lastDecision; }
    if (d.action==='NO TRADE') { this.noTrades++; this.specialistNoTrades[specialist]++; this.lastDecision=d; this.save(); return d; }
    const depthRaw=d.side==='yes'?market.yesAskSize:market.noAskSize;
    const depth=Number.isFinite(Number(depthRaw))?Math.max(0,Math.floor(Number(depthRaw))):this.maxContracts;
    let count=Math.min(this.maxContracts,depth);
    const specialistCash=this.specialistCash[specialist];
    while(count>0){const fee=estimateTakerFeeDollars(d.executableAsk,count,this.feeRate,market.feeMultiplier??1), cost=d.executableAsk*count+fee;if(cost<=specialistCash+1e-9&&cost<=this.maxExposure+1e-9)break;count--;}
    if(count<=0){this.noTrades++;this.specialistNoTrades[specialist]++;this.lastDecision={...d,action:'NO TRADE',reason:depth<=0?'insufficient_depth':'ml_paper_bankroll_or_exposure'};this.save();return this.lastDecision;}
    const fee=estimateTakerFeeDollars(d.executableAsk,count,this.feeRate,market.feeMultiplier??1), entryNotional=d.executableAsk*count,totalCost=entryNotional+fee;
    const pos={id:`mlp-${specialist}-${market.ticker}-${this.now()}`,ticker:market.ticker,timestamp:this.now(),closeTime:market.closeTime||null,model:specialist,activeSpecialist:specialist,side:d.side,contracts:count,entryPrice:d.executableAsk,executableAsk:d.executableAsk,modelProbability:d.modelYesProbability,kalshiProbability:d.kalshiProbability,rawEdge:d.rawEdge,estimatedFee:fee,afterFeeEdge:d.afterFeeEdge,timeRemainingMs:d.timeRemainingMs,dataSupportStatus:prediction?.dataSupportStatus??null,featureDriftStatus:prediction?.featureDriftStatus??null,totalCost,entryNotional,settlementResult:null,realizedPnl:null,settledAt:null};
    this.specialistCash[specialist]-=totalCost;this.cash-=totalCost;this.positions.push(pos);this.enteredTickers.add(entryKey);this.lastDecision={...d,activeSpecialist:specialist,contracts:count,estimatedFee:fee,reason:'entered'};console.log(`[MLPaper][${specialist}] ${d.action} ${market.ticker} x${count} @ ${(d.executableAsk*100).toFixed(1)}c | after-fee edge ${(d.afterFeeEdge*100).toFixed(1)}%`);this.save();return this.lastDecision;
  }
  settle(ticker,result,settledAt=this.now()) {
    if(result!=='yes'&&result!=='no') return null;
    const matches=this.positions.filter(p=>p.ticker===ticker);if(!matches.length)return null;
    const closed=[];
    for(const p of matches){const specialist=this._ensureSpecialist(p.activeSpecialist||p.model),won=p.side===result,payout=won?p.contracts:0,pnl=payout-p.totalCost;this.specialistCash[specialist]+=payout;this.cash+=payout;this.specialistRealizedPnl[specialist]+=pnl;this.realizedPnl+=pnl;const c={...p,settlementResult:result,realizedPnl:pnl,settledAt,won,payout};this.trades.push(c);closed.push(c);console.log(`[MLPaper][${specialist}] SETTLED ${ticker}=${result.toUpperCase()} | ${won?'WIN':'LOSS'} ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);}
    this.positions=this.positions.filter(p=>p.ticker!==ticker);this.save();return closed.length===1?closed[0]:closed;
  }
  // HOLD invariant: v2.6.1 exposes no sell/close/take-profit method.
  snapshot(markets=[]) {
    const settled=this.trades.length,wins=this.trades.filter(t=>t.won),losses=this.trades.filter(t=>!t.won),grossWin=wins.reduce((s,t)=>s+t.realizedPnl,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.realizedPnl,0));
    const exposure=this.positions.reduce((s,p)=>s+p.totalCost,0);let mark=0;const open=this.positions.map(p=>{const m=markets.find(x=>x.ticker===p.ticker),px=Number(p.side==='yes'?m?.yesBid:m?.noBid);const currentPrice=Number.isFinite(px)&&px>=0?px:null;const unrealized=currentPrice==null?null:currentPrice*p.contracts-p.totalCost;if(unrealized!=null)mark+=currentPrice*p.contracts;return {...p,currentPrice,unrealizedPnl:unrealized,timeRemainingMs:Math.max(0,(p.closeTime||this.now())-this.now())};});
    const avg=a=>a.length?a.reduce((s,t)=>s+t.realizedPnl,0)/a.length:null, avgEdge=this.trades.concat(this.positions).length?this.trades.concat(this.positions).reduce((s,t)=>s+(Number(t.afterFeeEdge)||0),0)/this.trades.concat(this.positions).length:null;
    const bySpecialist={};for(const name of ['GLOBAL','EARLY','LATE','FINAL','RESIDUAL']){const ts=this.trades.filter(t=>this._specialistName(t.activeSpecialist||t.model)===name), ps=this.positions.filter(p=>this._specialistName(p.activeSpecialist||p.model)===name), ws=ts.filter(t=>t.won), ls=ts.filter(t=>!t.won), gp=ws.reduce((s,t)=>s+t.realizedPnl,0), gl=Math.abs(ls.reduce((s,t)=>s+t.realizedPnl,0));bySpecialist[name]={startingCash:this.specialistStartingCash,cash:this.specialistCash[name],marketsEvaluated:this.marketsEvaluated[name]?.size||0,snapshotEvaluations:this.snapshotEvaluations[name]||0,trades:ts.length+ps.length,settledTrades:ts.length,wins:ws.length,losses:ls.length,winRate:ts.length?ws.length/ts.length:null,realizedPnl:ts.reduce((s,t)=>s+t.realizedPnl,0),openPositions:ps.length,openExposure:ps.reduce((s,p)=>s+p.totalCost,0),averageWin:avg(ws),averageLoss:avg(ls),expectancy:ts.length?ts.reduce((s,t)=>s+t.realizedPnl,0)/ts.length:null,profitFactor:gl>0?gp/gl:(gp>0?Infinity:null),noTrades:this.specialistNoTrades[name]||0,duplicateSkips:this.specialistDuplicateSkips[name]||0};}
    return {enabled:this.enabled,status:this.enabled?'ACTIVE':'OFF',simulated:true,startingCash:this.startingCash,cash:Object.values(this.specialistCash).reduce((a,b)=>a+b,0),equity:Object.values(this.specialistCash).reduce((a,b)=>a+b,0)+mark,realizedPnl:this.realizedPnl,openExposure:exposure,opportunitiesEvaluated:this.opportunitiesEvaluated,trades:this.trades.length+this.positions.length,noTrades:this.noTrades,duplicateSkips:this.duplicateSkips,settledTrades:settled,wins:wins.length,losses:losses.length,winRate:settled?wins.length/settled:null,averageWin:avg(wins),averageLoss:avg(losses),profitFactor:grossLoss>0?grossWin/grossLoss:(grossWin>0?Infinity:null),expectancy:settled?this.realizedPnl/settled:null,roi:this.startingCash?this.realizedPnl/this.startingCash:null,averageEntryEdge:avgEdge,lastDecision:this.lastDecision,openPositions:open,recentTrades:this.trades.slice(-20).reverse(),bySpecialist};
  }
}
module.exports=MLPaperHoldRuntime;
