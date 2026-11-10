'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mlPipeline = require('./ml-pipeline');
const {FULL_FEATURE_SCHEMA,HISTORICAL_UNAVAILABLE_FEATURES,MARKET_ONLY_FEATURE_SCHEMA,MARKET_ONLY_FEATURE_INDEXES,MARKET_ONLY_FEATURE_NAMES}=require('./ml-feature-schema');

const SERIES = 'KXBTC15M';
const FEATURE_SCHEMA_VERSION = 'v1';
const HISTORICAL_SCHEMA_VERSION = 'hist-v1';
const UNAVAILABLE_FEATURES = HISTORICAL_UNAVAILABLE_FEATURES;
const SAMPLE_OFFSETS_S = [720,600,480,360,300,240,180,120,90,60,30];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function unixMs(v) { if (v == null) return null; if (typeof v === 'number') return v > 1e12 ? v : v * 1000; const t=Date.parse(v); return Number.isFinite(t)?t:null; }
function clip01(v){ return Math.max(0.001, Math.min(0.999, v)); }
function dollar(v, cents) { const d=num(v); if(d!=null) return d; const c=num(cents); return c==null?null:c/100; }
function candleClose(x){ if(x==null) return null; if(typeof x==='number') return x; return dollar(x.close_dollars ?? x.close, null); }

function normalizeKalshiCandle(c) {
  const endMs = unixMs(c.end_period_ts ?? c.end_ts ?? c.ts ?? c.time ?? c.period_end);
  const price = c.price || c.yes_price || {};
  const yesBid = c.yes_bid || {};
  const yesAsk = c.yes_ask || {};
  const tradeClose = candleClose(price);
  let bid = candleClose(yesBid), ask = candleClose(yesAsk);
  if (bid == null && ask != null) bid = Math.max(0.001, ask - 0.01);
  if (ask == null && bid != null) ask = Math.min(0.999, bid + 0.01);
  if (bid == null && tradeClose != null) bid = tradeClose;
  if (ask == null && tradeClose != null) ask = tradeClose;
  return { endMs, yesBid:bid, yesAsk:ask, tradeClose, volume:num(c.volume_fp ?? c.volume), openInterest:num(c.open_interest_fp ?? c.open_interest) };
}

function normalizeBtcCandle(c) {
  if (Array.isArray(c)) return { tsMs:Number(c[0])*1000, low:num(c[1]), high:num(c[2]), open:num(c[3]), close:num(c[4]), volume:num(c[5]) };
  return { tsMs:unixMs(c.time ?? c.ts), low:num(c.low), high:num(c.high), open:num(c.open), close:num(c.close), volume:num(c.volume) };
}

function marketTarget(m) {
  for (const v of [m.floor_strike, m.floorStrike, m.strike, m.strike_value, m.settlement_value_dollars]) { const n=num(v); if(n!=null && n>1000) return n; }
  const text = `${m.title||''} ${m.yes_sub_title||''}`;
  const hits = [...text.matchAll(/\$?([0-9]{2,3}(?:,[0-9]{3})+(?:\.\d+)?)/g)].map(x=>Number(x[1].replace(/,/g,''))).filter(x=>x>1000);
  return hits.length ? hits[0] : null;
}

function latestAtOrBefore(rows, ts, key='tsMs') { let out=null; for(const r of rows){ if(r[key] <= ts && (!out || r[key] > out[key])) out=r; } return out; }
function realizedVol(btc, ts, minutes=5) { const xs=btc.filter(x=>x.tsMs<=ts && x.tsMs>=ts-minutes*60000 && x.close>0).sort((a,b)=>a.tsMs-b.tsMs); if(xs.length<3)return null; const rs=[]; for(let i=1;i<xs.length;i++)rs.push(Math.log(xs[i].close/xs[i-1].close)); const mean=rs.reduce((a,b)=>a+b,0)/rs.length; return Math.sqrt(rs.reduce((s,x)=>s+(x-mean)**2,0)/rs.length); }
function trendMetrics(btc, ts) { const now=latestAtOrBefore(btc,ts), old=latestAtOrBefore(btc,ts-3*60000); if(!now||!old||!old.close)return {trend:'NEUTRAL',strength:0,roc:0}; const roc=(now.close-old.close)/old.close*100; return {trend:roc>0.02?'BULLISH':roc<-0.02?'BEARISH':'NEUTRAL',strength:Math.min(1,Math.abs(roc)/0.5),roc}; }
function regime(sec){ if(sec<=120)return 'FINAL'; if(sec<=300)return 'LATE'; return 'EARLY'; }

class HistoricalDatasetBuilder {
  constructor({ kalshi, btc, staging, now=()=>Date.now(), requestDelayMs=0, sleep=ms=>new Promise(r=>setTimeout(r,ms)), logger=console }={}) {
    this.kalshi=kalshi; this.btc=btc; this.staging=staging; this.now=now; this.requestDelayMs=Math.max(0,Number(requestDelayMs)||0); this.sleep=sleep; this.logger=logger;
  }

  static observationId(ticker, tsMs) { return `historical:${ticker}:${Math.floor(tsMs/60000)*60000}`; }

  reconstructMarket(market, kalshiCandles, btcCandles) {
    const closeMs=unixMs(market.close_time ?? market.closeTime), openMs=unixMs(market.open_time ?? market.openTime) || (closeMs-900000);
    const result=String(market.result||'').toLowerCase(); const target=marketTarget(market);
    if(!closeMs || !target || !['yes','no'].includes(result)) return { rows:[], skip:!closeMs?'missing_close_time':!target?'missing_target':'unresolved' };
    const kc=kalshiCandles.map(normalizeKalshiCandle).filter(x=>x.endMs).sort((a,b)=>a.endMs-b.endMs);
    const bc=btcCandles.map(normalizeBtcCandle).filter(x=>x.tsMs&&x.close).sort((a,b)=>a.tsMs-b.tsMs);
    const rows=[];
    for(const offset of SAMPLE_OFFSETS_S){ const tsMs=closeMs-offset*1000; if(tsMs<openMs)continue; const k=latestAtOrBefore(kc,tsMs,'endMs'), b=latestAtOrBefore(bc,tsMs); if(!k||!b||k.yesAsk==null||k.yesBid==null)continue;
      const sigma=realizedVol(bc,tsMs), tr=trendMetrics(bc,tsMs); if(sigma==null)continue;
      const yesAsk=clip01(k.yesAsk), yesBid=clip01(k.yesBid), noAsk=clip01(1-yesBid), noBid=clip01(1-yesAsk);
      const signal={type:'DIRECTIONAL_YES_HISTORICAL',ticker:market.ticker,side:'yes',edge:0,modelProb:yesAsk,priceCents:Math.round(yesAsk*100),contracts:0};
      const vector=mlPipeline.extractFeatures(signal,{btcPrice:b.close,openPrice:target,timeRemainingMs:offset*1000,totalDurationMs:900000,sigma,trend:tr.trend,trendStrength:tr.strength,trendROC:tr.roc,yesAsk,noAsk,yesBid,noBid,recentWinRate:.5,recentPnL:0,streak:0,balanceAvailable:0});
      rows.push({observation_id:HistoricalDatasetBuilder.observationId(market.ticker,tsMs),ts:new Date(tsMs).toISOString(),ticker:market.ticker,signal_type:'MARKET_SNAPSHOT_YES',predicted_side:'yes',features:vector,label:result==='yes'?1:0,settled_result:result,source:'historical',quality_grade:'B',collector_version:'historical-builder-v1',feature_schema_version:FEATURE_SCHEMA_VERSION,historical_schema_version:HISTORICAL_SCHEMA_VERSION,resolution_seconds:60,specialist_regime:regime(offset),unavailable_features:HISTORICAL_UNAVAILABLE_FEATURES,metadata:{target_price:target,btc_price:b.close,kalshi_yes_bid:yesBid,kalshi_yes_ask:yesAsk,kalshi_trade_close:k.tradeClose,time_remaining_s:offset,orderbook_depth_available:false}});
    }
    return {rows,skip:null};
  }

  _providerHealth() { return {kalshi:{},coinbase:{}}; }
  _mergeClientHealth(fetchHealth) {
    for (const [provider,client] of [['kalshi',this.kalshi],['coinbase',this.btc]]) {
      const h=client && typeof client.getHealth==='function' ? client.getHealth() : null;
      if(h) fetchHealth[provider]={...fetchHealth[provider],...h.categories};
    }
  }
  _checkpointRead(checkpointPath) {
    if(!checkpointPath || !fs.existsSync(checkpointPath)) return {completed:[]};
    try { const x=JSON.parse(fs.readFileSync(checkpointPath,'utf8')); return Array.isArray(x.completed)?x:{completed:[]}; }
    catch(e){ this.logger.warn(`[HistoricalML] ignoring corrupted checkpoint ${checkpointPath}: ${e.message}`); return {completed:[],corrupted:true}; }
  }
  _checkpointWrite(checkpointPath,state) {
    if(!checkpointPath)return; fs.mkdirSync(path.dirname(checkpointPath),{recursive:true}); const tmp=`${checkpointPath}.tmp-${process.pid}`; fs.writeFileSync(tmp,JSON.stringify(state,null,2)); fs.renameSync(tmp,checkpointPath);
  }
  _failure(provider,stage,ticker,e) { const c=classifyHistoricalError(e); return {ticker,provider,category:c.category,status:c.status||null,code:c.code||null,stage}; }

  qualityReport(rows, marketsSeen=0, skips={}, extra={}) { const tickers=new Set(rows.map(r=>r.ticker)); const yes=new Set(rows.filter(r=>r.label===1).map(r=>r.ticker)); const no=new Set(rows.filter(r=>r.label===0).map(r=>r.ticker)); const regimes={EARLY:0,LATE:0,FINAL:0}; rows.forEach(r=>regimes[r.specialist_regime]++); return {marketsSeen,marketsReconstructed:tickers.size,yesMarkets:yes.size,noMarkets:no.size,observations:rows.length,regimes,qualityGrades:{B:rows.length},orderbookDepthCoverage:0,unavailableFeatures:HISTORICAL_UNAVAILABLE_FEATURES,marketOnlyFeatureIndexes:MARKET_ONLY_FEATURE_INDEXES,marketOnlyFeatureNames:MARKET_ONLY_FEATURE_NAMES,skips,...extra}; }

  async run({markets=[],dryRun=true,resume=false,checkpointPath=null}={}) {
    const rows=[],skips={},failures=[]; const cp=resume?this._checkpointRead(checkpointPath):{completed:[]}; const completed=new Set(cp.completed||[]); let resumedMarkets=0, marketsRecoveredThroughRetry=0;
    const beforeRecovered=(this.kalshi?.getHealth?.().recoveredAfterRetry||0)+(this.btc?.getHealth?.().recoveredAfterRetry||0);
    for(const market of markets){
      if(resume && completed.has(market.ticker)){resumedMarkets++;continue;}
      const start=Math.floor((unixMs(market.open_time)||unixMs(market.close_time)-900000)/1000)-360; const end=Math.floor(unixMs(market.close_time)/1000)+60;
      let kc,bc; let recoveredBefore=(this.kalshi?.getHealth?.().recoveredAfterRetry||0)+(this.btc?.getHealth?.().recoveredAfterRetry||0);
      try { kc=await this.kalshi.candles(market,start,end); } catch(e){ const f=this._failure('kalshi','Kalshi candles',market.ticker,e); failures.push(f); skips[`kalshi_${f.category}`]=(skips[`kalshi_${f.category}`]||0)+1; continue; }
      if(this.requestDelayMs) await this.sleep(this.requestDelayMs);
      try { bc=await this.btc.candles(start,end); } catch(e){ const f=this._failure('coinbase','Coinbase candles',market.ticker,e); failures.push(f); skips[`coinbase_${f.category}`]=(skips[`coinbase_${f.category}`]||0)+1; continue; }
      const recoveredAfter=(this.kalshi?.getHealth?.().recoveredAfterRetry||0)+(this.btc?.getHealth?.().recoveredAfterRetry||0); if(recoveredAfter>recoveredBefore)marketsRecoveredThroughRetry++;
      const out=this.reconstructMarket(market,kc,bc); if(out.skip){skips[out.skip]=(skips[out.skip]||0)+1;continue;} rows.push(...out.rows);
      if(out.rows.length){completed.add(market.ticker);this._checkpointWrite(checkpointPath,{version:1,updatedAt:new Date(this.now()).toISOString(),completed:[...completed].sort()});}
      if(this.requestDelayMs) await this.sleep(this.requestDelayMs);
    }
    if(!dryRun && this.staging) await this.staging.upsert(rows);
    const fetchHealth=this._providerHealth(); this._mergeClientHealth(fetchHealth); for(const f of failures){fetchHealth[f.provider][f.category]=(fetchHealth[f.provider][f.category]||0)+1;}
    const clients=[this.kalshi,this.btc].map(x=>x?.getHealth?.()).filter(Boolean); const totals=clients.reduce((a,h)=>({requestsAttempted:a.requestsAttempted+(h.requestsAttempted||0),retriesAttempted:a.retriesAttempted+(h.retriesAttempted||0),recoveredAfterRetry:a.recoveredAfterRetry+(h.recoveredAfterRetry||0),permanentFailures:a.permanentFailures+(h.permanentFailures||0)}),{requestsAttempted:0,retriesAttempted:0,recoveredAfterRetry:0,permanentFailures:0});
    return {rows,report:this.qualityReport(rows,markets.length,skips,{fetchHealth,...totals,marketsRecoveredThroughRetry,resumedMarkets,checkpoint:checkpointPath||null,failures}),written:dryRun?0:rows.length};
  }
}

function classifyHistoricalError(err) {
  const status=Number(err?.response?.status)||null; const raw=String(err?.code||'').toUpperCase(); const msg=String(err?.message||'').toLowerCase();
  let category='other';
  if(status===429)category='429'; else if(status===404)category='404'; else if(status>=500&&status<=599)category='5xx'; else if(status===408)category='timeout';
  else if(['ECONNABORTED','ETIMEDOUT'].includes(raw)||msg.includes('timeout'))category='timeout';
  else if(['ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN'].includes(raw)||msg.includes('network')||msg.includes('socket hang up'))category='network';
  else if(status)category=String(status);
  const transient=status===408||status===429||[500,502,503,504].includes(status)||category==='timeout'||category==='network';
  return {category,status,code:raw||null,transient};
}
function retryAfterMs(headers,capMs) { const v=headers?.['retry-after']??headers?.['Retry-After']; if(v==null)return null; const n=Number(v); let ms=Number.isFinite(n)?n*1000:Date.parse(v)-Date.now(); if(!Number.isFinite(ms)||ms<0)return null; return Math.min(ms,capMs); }

class RetryingHistoryHttpClient {
  constructor({http=null,maxAttempts=4,baseDelayMs=500,maxRetryAfterMs=10000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),random=Math.random}={}) { this.http=http||require('axios');this.maxAttempts=Math.max(1,Number(maxAttempts)||4);this.baseDelayMs=Math.max(0,Number(baseDelayMs)||0);this.maxRetryAfterMs=Math.max(0,Number(maxRetryAfterMs)||0);this.sleep=sleep;this.random=random;this.health={requestsAttempted:0,retriesAttempted:0,recoveredAfterRetry:0,permanentFailures:0,categories:{}}; }
  getHealth(){return JSON.parse(JSON.stringify(this.health));}
  async _request(url,config){let last;for(let attempt=1;attempt<=this.maxAttempts;attempt++){this.health.requestsAttempted++;try{const r=await this.http.get(url,config);if(attempt>1)this.health.recoveredAfterRetry++;return r;}catch(e){last=e;const c=classifyHistoricalError(e);this.health.categories[c.category]=(this.health.categories[c.category]||0)+1;if(!c.transient||attempt>=this.maxAttempts){this.health.permanentFailures++;throw e;}this.health.retriesAttempted++;const ra=retryAfterMs(e?.response?.headers,this.maxRetryAfterMs);const exp=Math.min(this.maxRetryAfterMs||Infinity,this.baseDelayMs*2**(attempt-1));const wait=ra!=null?ra:Math.round(exp*(.9+.2*this.random()));if(wait>0)await this.sleep(wait);}}throw last;}
}
class PublicKalshiHistoryClient extends RetryingHistoryHttpClient {
  constructor({baseUrl='https://external-api.kalshi.com/trade-api/v2',...opts}={}){super(opts);this.baseUrl=baseUrl;}
  async _get(path,params){const r=await this._request(this.baseUrl+path,{params,timeout:15000});return r.data;}
  async discoverArchived({series=SERIES,limitMarkets=500,cursor=null}={}){const out=[];let cur=cursor;while(out.length<limitMarkets){const d=await this._get('/historical/markets',{series_ticker:series,limit:Math.min(1000,limitMarkets-out.length),cursor:cur||undefined});out.push(...(d.markets||[]));cur=d.cursor;if(!cur)break;}return out;}
  async candles(market,start,end){const d=await this._get(`/historical/markets/${encodeURIComponent(market.ticker)}/candlesticks`,{start_ts:start,end_ts:end,period_interval:1});return d.candlesticks||[];}
}
class CoinbaseHistoryClient extends RetryingHistoryHttpClient { constructor(opts={}){super(opts);} async candles(start,end){const r=await this._request('https://api.exchange.coinbase.com/products/BTC-USD/candles',{params:{start:new Date(start*1000).toISOString(),end:new Date(end*1000).toISOString(),granularity:60},timeout:15000});return r.data||[];} }

module.exports={HistoricalDatasetBuilder,PublicKalshiHistoryClient,CoinbaseHistoryClient,RetryingHistoryHttpClient,classifyHistoricalError,retryAfterMs,normalizeKalshiCandle,normalizeBtcCandle,marketTarget,UNAVAILABLE_FEATURES,HISTORICAL_UNAVAILABLE_FEATURES,FULL_FEATURE_SCHEMA,MARKET_ONLY_FEATURE_SCHEMA,MARKET_ONLY_FEATURE_INDEXES,MARKET_ONLY_FEATURE_NAMES,SAMPLE_OFFSETS_S};
