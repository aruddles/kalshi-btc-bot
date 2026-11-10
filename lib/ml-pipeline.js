/**
 * ML Pipeline — Feature extraction, model training, and prediction
 * for signal quality scoring.
 *
 * Architecture:
 *   1. Feature Extraction: Convert market state → numeric feature vector
 *   2. Training: Gradient-boosted decision stumps (lightweight, no TensorFlow)
 *   3. Prediction: Score each signal with confidence [0, 1]
 *   4. RAG Context: Retrieve similar historical trades for context-aware decisions
 *
 * The ML model learns which signals actually win by looking at:
 *   - Market microstructure (spread, depth, time-to-close)
 *   - Model confidence (probability, edge, z-score)
 *   - Trend alignment (EMA crossover, ROC)
 *   - Volatility regime (realized vol, vol-of-vol)
 *   - Historical performance (strategy win rate, recent streak)
 *
 * Storage: Supabase (Postgres + pgvector for RAG embeddings)
 */

const supabase = require('./supabase');
const {FEATURE_NAMES}=require('./ml-feature-schema');
const { HistoricalChallengers } = require('./ml-challengers');

class MLPipeline {
  constructor() {
    this.modelVersion = 'v1.0';
    this.trees = [];          // Trained decision stumps
    this.featureNames = [...FEATURE_NAMES];
    this.trained = false;
    this.trainingSize = 0;
    this.validationSize = 0;
    this.validationAccuracy = null;
    this.validationBrier = null;
    this.validationMarketAccuracy = null;
    this.datasetMarkets = 0;
    this.datasetSnapshots = 0;
    this.datasetYesMarkets = 0;
    this.datasetNoMarkets = 0;
    this.datasetYesSnapshots = 0;
    this.datasetNoSnapshots = 0;
    this.trainingMarkets = 0;
    this.validationMarkets = 0;
    this.calibrationMarkets = 0;
    this.testMarkets = 0;
    this.calibrationSize = 0;
    this.testSize = 0;
    this.calibration = null;
    this.evaluation = null;
    this.topFeatures = [];
    this.liveShadow = null;
    this.lastTrainedAt = null;
    this.trainingStatus = 'COLLECTING';
    this.specialists = {};
    this.residualModel = null;
    this.dataHealth = null;
    this.challengers = new HistoricalChallengers();

    // Feature normalization params (learned during training)
    this.featureMeans = [];
    this.featureStds = [];
  }

  // ===== Feature Extraction =====

  /**
   * Extract a numeric feature vector from a signal + market context.
   * Returns a flat array of numbers suitable for ML model input.
   */
  extractFeatures(signal, marketContext) {
    const {
      btcPrice = 0, openPrice = 0, timeRemainingMs = 0, totalDurationMs = 900000,
      sigma = 0.0015, trend = 'NEUTRAL', trendStrength = 0, trendROC = 0,
      yesAsk = 0.5, noAsk = 0.5, yesBid = 0.5, noBid = 0.5,
      recentWinRate = 0.5, recentPnL = 0, streak = 0,
      balanceAvailable = 100,
    } = marketContext;

    const move = openPrice > 0 ? (btcPrice - openPrice) / openPrice : 0;
    const timeRemaining = totalDurationMs > 0 ? timeRemainingMs / totalDurationMs : 0;
    const spread = yesAsk - yesBid;
    const noSpread = noAsk - noBid;
    const combinedAsk = yesAsk + noAsk;
    const isDirectional = signal.type.startsWith('DIRECTIONAL');
    const isPolyArb = signal.type.startsWith('POLY_ARB');
    const isDualSide = signal.type.startsWith('DUAL_SIDE');
    const isBuyYes = signal.side === 'yes';

    // Trend alignment
    const trendAligned = (isBuyYes && trend === 'BULLISH') || (!isBuyYes && trend === 'BEARISH');
    const trendCounter = (isBuyYes && trend === 'BEARISH') || (!isBuyYes && trend === 'BULLISH');

    const features = [
      // Price movement features
      move * 1000,                              // 0: spot move (scaled)
      Math.abs(move) * 1000,                    // 1: absolute move magnitude
      move > 0 ? 1 : 0,                         // 2: move direction (binary)

      // Time features
      timeRemaining,                             // 3: fraction of time remaining
      Math.max(0, 1 - timeRemaining) * 100,     // 4: time elapsed (%)

      // Volatility features
      sigma * 1000,                              // 5: realized volatility (scaled)
      sigma > 0.002 ? 1 : 0,                    // 6: high-vol regime flag

      // Signal features
      signal.edge,                               // 7: signal edge (%)
      signal.modelProb,                          // 8: model probability
      signal.priceCents / 100,                   // 9: contract price (decimal)
      signal.contracts,                          // 10: position size (contracts)

      // Market microstructure
      spread * 100,                              // 11: YES bid-ask spread (%)
      noSpread * 100,                            // 12: NO bid-ask spread (%)
      combinedAsk * 100,                         // 13: combined ask cost
      (1 - combinedAsk) * 100,                  // 14: dual-side profit margin

      // Strategy type (one-hot)
      isDirectional ? 1 : 0,                     // 15: is directional
      isPolyArb ? 1 : 0,                        // 16: is poly arb
      isDualSide ? 1 : 0,                       // 17: is dual side

      // Side
      isBuyYes ? 1 : 0,                         // 18: buying YES side

      // Trend features
      trendAligned ? 1 : 0,                      // 19: aligned with trend
      trendCounter ? 1 : 0,                      // 20: counter to trend
      trendStrength,                              // 21: trend strength [0, 1]
      trendROC,                                   // 22: rate of change (%)

      // Historical performance
      recentWinRate,                              // 23: recent win rate [0, 1]
      recentPnL,                                  // 24: recent P&L ($)
      streak,                                     // 25: current streak (+/-)

      // Position sizing context
      balanceAvailable,                           // 26: available balance
    ];

    this.featureNames = [...FEATURE_NAMES];

    return features;
  }

  // ===== Lightweight Gradient Boosted Stumps =====

  /**
   * Train a simple gradient-boosted model from historical signal outcomes.
   * Uses decision stumps (single-feature splits) — no external ML library needed.
   *
   * This is intentionally simple: 50-100 stumps, each splitting on one feature.
   * Good enough for signal quality scoring without heavy dependencies.
   */
  _chronologicalSplit(data) {
    const firstTs = new Map();
    for (const r of data) if (r.ticker) {
      const t = Date.parse(r.ts || '') || 0;
      if (!firstTs.has(r.ticker) || t < firstTs.get(r.ticker)) firstTs.set(r.ticker, t);
    }
    const tickers = [...firstTs].sort((a,b) => a[1]-b[1] || a[0].localeCompare(b[0])).map(x=>x[0]);
    if (tickers.length < 3) return null;
    let trainN = Math.max(1, Math.floor(tickers.length * .70));
    let calN = Math.max(1, Math.floor(tickers.length * .15));
    if (trainN + calN >= tickers.length) trainN = Math.max(1, tickers.length - calN - 1);
    const train = new Set(tickers.slice(0, trainN));
    const calibration = new Set(tickers.slice(trainN, trainN + calN));
    const test = new Set(tickers.slice(trainN + calN));
    return { tickers, train, calibration, test,
      trainData:data.filter(r=>train.has(r.ticker)), calibrationData:data.filter(r=>calibration.has(r.ticker)), testData:data.filter(r=>test.has(r.ticker)) };
  }

  _fitCalibration(rows, predictor = r => this.predict(r.features).confidence) {
    if (!rows.length) return null;
    const labels = new Set(rows.map(r=>Number(r.label)));
    if (labels.size < 2) return null;
    const ps = rows.map(predictor);
    const xs = ps.map(p=>Math.log(this._clip(p)/(1-this._clip(p))));
    let a=1,b=0; const lr=.03;
    for(let iter=0;iter<1200;iter++){
      let ga=0,gb=0;
      for(let i=0;i<xs.length;i++){const q=1/(1+Math.exp(-(a*xs[i]+b))); const e=q-Number(rows[i].label); ga+=e*xs[i];gb+=e;}
      a-=lr*ga/xs.length;b-=lr*gb/xs.length;
    }
    return {a,b,size:rows.length,markets:new Set(rows.map(r=>r.ticker)).size};
  }
  _clip(p){ return Math.max(1e-6,Math.min(1-1e-6,Number(p))); }
  _applyCalibration(p, calibration){ if(!calibration)return this._clip(p); const x=Math.log(this._clip(p)/(1-this._clip(p))); return this._clip(1/(1+Math.exp(-(calibration.a*x+calibration.b)))); }
  calibrateProbability(p){ return this._applyCalibration(p,this.calibration); }
  _metrics(rows, probs){ if(!rows.length)return {observations:0,accuracy:null,brier:null,logLoss:null}; let c=0,b=0,ll=0; rows.forEach((r,i)=>{const y=Number(r.label),p=this._clip(probs[i]);c+=((p>=.5?1:0)===y);b+=(p-y)**2;ll+=-(y*Math.log(p)+(1-y)*Math.log(1-p));}); return {observations:rows.length,accuracy:c/rows.length,brier:b/rows.length,logLoss:ll/rows.length}; }
  _secondsRemaining(row){ const v=Number(row.features?.[3]); return Number.isFinite(v)?v*900:null; }
  _marketMetricsSafe(rows, probs, safeCutoffSeconds=30){
    const m=new Map(); rows.forEach((r,i)=>{if(!m.has(r.ticker))m.set(r.ticker,[]);m.get(r.ticker).push({r,p:probs[i]});});
    let correct=0,yesC=0,yesN=0,noC=0,noN=0,excluded=0;
    for(const a of m.values()){
      const eligible=a.filter(x=>{const sec=this._secondsRemaining(x.r);return sec!=null&&sec>=safeCutoffSeconds;}).sort((x,y)=>(Date.parse(x.r.ts)||0)-(Date.parse(y.r.ts)||0));
      if(!eligible.length){excluded++;continue;} const x=eligible[eligible.length-1], pred=x.p>=.5?1:0,label=Number(x.r.label);correct+=pred===label;if(label){yesN++;yesC+=pred===label}else{noN++;noC+=pred===label}
    }
    const used=m.size-excluded; return {markets:used,excludedMarkets:excluded,accuracy:used?correct/used:null,yesAccuracy:yesN?yesC/yesN:null,noAccuracy:noN?noC/noN:null,rule:`latest eligible snapshot with >=${safeCutoffSeconds}s remaining`};
  }
  _marketMetrics(rows, probs){ const m=new Map(); rows.forEach((r,i)=>{if(!m.has(r.ticker))m.set(r.ticker,[]);m.get(r.ticker).push({r,p:probs[i]});}); let correct=0;for(const a of m.values()){a.sort((x,y)=>(Date.parse(x.r.ts)||0)-(Date.parse(y.r.ts)||0));const x=a[a.length-1];correct+=(x.p>=.5?1:0)===Number(x.r.label);}return {markets:m.size,accuracy:m.size?correct/m.size:null,rule:'legacy final eligible snapshot (compatibility helper; v2.6 evaluation uses safe cutoff)'}; }
  _kalshiProbability(row){ const p=Number(row.features?.[9]); return Number.isFinite(p)&&p>0&&p<1?p:null; }
  _bucket(rows, probs, kind){ const defs=kind==='time'?[[600,901,'10–15m'],[300,600,'5–10m'],[120,300,'2–5m'],[30,120,'30s–2m'],[0,30,'<30s']]:[[0,.1,'0–10%'],[.1,.2,'10–20%'],[.2,.3,'20–30%'],[.3,.4,'30–40%'],[.4,.5,'40–50%'],[.5,.6,'50–60%'],[.6,.7,'60–70%'],[.7,.8,'70–80%'],[.8,.9,'80–90%'],[.9,1.000001,'90–100%']]; return defs.map(([lo,hi,label])=>{const ix=[];rows.forEach((r,i)=>{const v=kind==='time'?this._secondsRemaining(r):probs[i];if(Number.isFinite(v)&&v>=lo&&v<hi)ix.push(i)});const rr=ix.map(i=>rows[i]),pp=ix.map(i=>probs[i]);return {bucket:label,...this._metrics(rr,pp),markets:new Set(rr.map(r=>r.ticker)).size,avgPredicted:pp.length?pp.reduce((a,b)=>a+b,0)/pp.length:null,actualYesRate:rr.length?rr.reduce((a,r)=>a+Number(r.label),0)/rr.length:null,lowSample:rr.length<30};}); }
  _edgeBuckets(rows, cal, kalshi){
    const defs=[[0,.02,'0–2%'],[.02,.05,'2–5%'],[.05,.10,'5–10%'],[.10,.15,'10–15%'],[.15,Infinity,'15%+']];
    return defs.map(([lo,hi,label])=>{const ix=[];rows.forEach((r,i)=>{if(kalshi[i]!=null){const signed=cal[i]-kalshi[i],e=Math.abs(signed);if(e>=lo&&e<hi)ix.push(i)}});const rr=ix.map(i=>rows[i]);let correct=0,edge=0,yesOpp=0,noOpp=0;ix.forEach(i=>{const signed=cal[i]-kalshi[i];const side=signed>=0?1:0;if(side)yesOpp++;else noOpp++;correct+=side===Number(rows[i].label);edge+=Math.abs(signed)});return {bucket:label,observations:ix.length,markets:new Set(rr.map(r=>r.ticker)).size,yesOpportunities:yesOpp,noOpportunities:noOpp,directionalAccuracy:ix.length?correct/ix.length:null,averageClaimedEdge:ix.length?edge/ix.length:null,brier:ix.length?this._metrics(rr,ix.map(i=>cal[i])).brier:null,hypotheticalPnl:null,roi:null,note:'Direction is symmetric: ML>Kalshi => YES, ML<Kalshi => NO. P&L unavailable without historical executable fill/fee rows.'};});
  }
  _timeEvaluation(rows,raw,cal,kp){const defs=[[600,901,'10–15m'],[300,600,'5–10m'],[120,300,'2–5m'],[30,120,'30s–2m'],[0,30,'<30s']];return defs.map(([lo,hi,bucket])=>{const ix=[];rows.forEach((r,i)=>{const sec=this._secondsRemaining(r);if(Number.isFinite(sec)&&sec>=lo&&sec<hi)ix.push(i)});const rr=ix.map(i=>rows[i]), valid=ix.filter(i=>kp[i]!=null);return {bucket,observations:ix.length,markets:new Set(rr.map(r=>r.ticker)).size,raw:this._metrics(rr,ix.map(i=>raw[i])),calibrated:this._metrics(rr,ix.map(i=>cal[i])),kalshi:this._metrics(valid.map(i=>rows[i]),valid.map(i=>kp[i]))};});}
  _evaluate(testData){const raw=testData.map(r=>this.predict(r.features).confidence),cal=raw.map(p=>this.calibrateProbability(p)),kp=testData.map(r=>this._kalshiProbability(r));return this._comparePredictions(testData,raw,cal,kp);}
  _comparePredictions(testData,raw,cal,kp){const eligible=testData.map((r,i)=>({r,i})).filter(x=>kp[x.i]!=null),kr=eligible.map(x=>x.r),kprobs=eligible.map(x=>kp[x.i]);const rawAll=this._metrics(testData,raw),calAll=this._metrics(testData,cal),rawM=this._metrics(kr,eligible.map(x=>raw[x.i])),calM=this._metrics(kr,eligible.map(x=>cal[x.i])),kalM=this._metrics(kr,kprobs);rawM.market=this._marketMetricsSafe(kr,eligible.map(x=>raw[x.i]));calM.market=this._marketMetricsSafe(kr,eligible.map(x=>cal[x.i]));kalM.market=this._marketMetricsSafe(kr,kprobs);return {raw:rawM,calibrated:calM,rawAll,calibratedAll:calAll,kalshi:kalM,kalshiMissing:testData.length-kr.length,rawBrierImprovementVsKalshi:kalM.brier==null?null:kalM.brier-rawM.brier,calibratedBrierImprovementVsKalshi:kalM.brier==null?null:kalM.brier-calM.brier,calibrationRaw:this._bucket(testData,raw,'cal'),calibrationCalibrated:this._bucket(testData,cal,'cal'),time:this._timeEvaluation(testData,raw,cal,kp),edge:this._edgeBuckets(testData,cal,kp)};}

  _fitStumpModel(rows){
    if(!rows.length)return null; const X=rows.map(d=>d.features),y=rows.map(d=>Number(d.label)),n=X[0].length;
    const means=Array(n).fill(0),stds=Array(n).fill(1);for(let j=0;j<n;j++){const c=X.map(r=>Number(r[j])||0);means[j]=c.reduce((a,b)=>a+b,0)/c.length;stds[j]=Math.sqrt(c.reduce((a,v)=>a+(v-means[j])**2,0)/c.length)||1;}
    const Xn=X.map(r=>r.map((v,j)=>(v-means[j])/stds[j])),residuals=y.map(v=>v-.5),lr=.1,trees=[];
    for(let t=0;t<Math.min(100,Math.floor(X.length/5));t++){let best=null,lossBest=Infinity;for(let j=0;j<n;j++){const z=Xn.map((r,i)=>({v:r[j],res:residuals[i]})).sort((a,b)=>a.v-b.v),mid=Math.floor(z.length/2);if(!mid)continue;const L=z.slice(0,mid),R=z.slice(mid),lp=L.reduce((a,x)=>a+x.res,0)/L.length,rp=R.reduce((a,x)=>a+x.res,0)/R.length,th=z[mid].v;let loss=0;for(let i=0;i<Xn.length;i++){const p=Xn[i][j]<th?lp:rp;loss+=(residuals[i]-p)**2}if(loss<lossBest){lossBest=loss;best={feature:j,threshold:th,leftPred:lp,rightPred:rp}}}if(!best)break;for(let i=0;i<Xn.length;i++)residuals[i]-=lr*(Xn[i][best.feature]<best.threshold?best.leftPred:best.rightPred);trees.push({...best,weight:lr});}
    return {means,stds,trees};
  }
  _predictStumpModel(model,features){if(!model||!model.trees.length)return .5;const xn=features.map((v,j)=>(v-(model.means[j]||0))/(model.stds[j]||1));let score=.5;for(const tree of model.trees)score+=tree.weight*(xn[tree.feature]<tree.threshold?tree.leftPred:tree.rightPred);return this._clip(1/(1+Math.exp(-4*(score-.5))));}
  _regime(row,name){const sec=this._secondsRemaining(row);if(sec==null)return false;if(name==='EARLY')return sec>=300&&sec<=900;if(name==='LATE')return sec>=120&&sec<300;if(name==='FINAL')return sec>=0&&sec<120;return false;}
  _trainSpecialists(split){
    const out={}; for(const name of ['EARLY','LATE','FINAL']){const tr=split.trainData.filter(r=>this._regime(r,name)),ca=split.calibrationData.filter(r=>this._regime(r,name)),te=split.testData.filter(r=>this._regime(r,name));if(tr.length<25||new Set(tr.map(r=>Number(r.label))).size<2){out[name]={status:'INSUFFICIENT_DATA',trainObservations:tr.length,testObservations:te.length};continue;}const model=this._fitStumpModel(tr),predict=r=>this._predictStumpModel(model,r.features),calibration=this._fitCalibration(ca,predict),spRaw=te.map(predict),spCal=spRaw.map(p=>this._applyCalibration(p,calibration)),globalRaw=te.map(r=>this.predict(r.features).confidence),globalCal=globalRaw.map(p=>this.calibrateProbability(p)),kp=te.map(r=>this._kalshiProbability(r));const specialist=this._comparePredictions(te,spRaw,spCal,kp),global=this._comparePredictions(te,globalRaw,globalCal,kp);out[name]={status:calibration?'READY':'RAW_ONLY',trainObservations:tr.length,trainMarkets:new Set(tr.map(r=>r.ticker)).size,calibrationObservations:ca.length,calibrationMarkets:new Set(ca.map(r=>r.ticker)).size,testObservations:te.length,testMarkets:new Set(te.map(r=>r.ticker)).size,calibration,model,evaluation:{specialist,global,kalshi:specialist.kalshi}};}
    return out;
  }
  _fitResidual(split){
    const train=split.trainData.filter(r=>this._kalshiProbability(r)!=null),cal=split.calibrationData.filter(r=>this._kalshiProbability(r)!=null),test=split.testData.filter(r=>this._kalshiProbability(r)!=null);if(train.length<25||new Set(train.map(r=>Number(r.label))).size<2)return {status:'INSUFFICIENT_DATA'};
    // Leakage-safe residual correction: learn a logistic correction to point-in-time Kalshi log-odds on TRAIN only.
    let a=1,b=0;const lr=.03;for(let iter=0;iter<1500;iter++){let ga=0,gb=0;for(const r of train){const k=this._kalshiProbability(r),x=Math.log(this._clip(k)/(1-this._clip(k))),q=1/(1+Math.exp(-(a*x+b))),e=q-Number(r.label);ga+=e*x;gb+=e;}a-=lr*ga/train.length;b-=lr*gb/train.length;}
    const rawPredict=r=>{const k=this._kalshiProbability(r),x=Math.log(this._clip(k)/(1-this._clip(k)));return this._clip(1/(1+Math.exp(-(a*x+b))));};const calibration=this._fitCalibration(cal,rawPredict);const raw=test.map(rawPredict),calibrated=raw.map(p=>this._applyCalibration(p,calibration)),kp=test.map(r=>this._kalshiProbability(r)),directRaw=test.map(r=>this.predict(r.features).confidence),directCal=directRaw.map(p=>this.calibrateProbability(p));return {status:calibration?'READY':'RAW_ONLY',method:'logistic correction of point-in-time Kalshi log-odds',a,b,trainObservations:train.length,calibrationObservations:cal.length,testObservations:test.length,calibration,evaluation:{residual:this._comparePredictions(test,raw,calibrated,kp),directML:this._comparePredictions(test,directRaw,directCal,kp),kalshi:this._metrics(test,kp)}};
  }
  _buildDataHealth(data,split){const markets=new Map();for(const r of data){if(!markets.has(r.ticker))markets.set(r.ticker,{ticker:r.ticker,label:Number(r.label),ts:Date.parse(r.ts||'')||0,snapshots:0});const m=markets.get(r.ticker);m.snapshots++;m.ts=Math.max(m.ts,Date.parse(r.ts||'')||0);}const ordered=[...markets.values()].sort((a,b)=>a.ts-b.ts);const recent=ordered.slice(-Math.min(30,ordered.length));const regimeCounts={EARLY:0,LATE:0,FINAL:0};for(const r of data)for(const n of Object.keys(regimeCounts))if(this._regime(r,n))regimeCounts[n]++;const newest=ordered.at(-1)?.ts||null,oldest=ordered[0]?.ts||null;return {totalSettledMarkets:markets.size,totalSnapshots:data.length,recentWindowMarkets:recent.length,recentYesMarkets:recent.filter(x=>x.label===1).length,recentNoMarkets:recent.filter(x=>x.label===0).length,recentSnapshots:recent.reduce((a,x)=>a+x.snapshots,0),oldestObservationAt:oldest?new Date(oldest).toISOString():null,newestObservationAt:newest?new Date(newest).toISOString():null,historySpanDays:oldest&&newest?(newest-oldest)/86400000:null,regimeSnapshots:regimeCounts,splitMarkets:{train:split.train.size,calibration:split.calibration.size,test:split.test.size}};}

  async train() {
    this.trainingStatus='TRAINING';
    const data=await supabase.getTrainingData();
    for(const row of data) if((row.settled_result==='yes'&&Number(row.label)!==1)||(row.settled_result==='no'&&Number(row.label)!==0)){this.trainingStatus='ERROR';console.error(`[ML] ERROR label integrity violation: ${row.ticker}`);return false;}
    const outcomes=new Map();data.forEach(r=>{if(r.ticker&&(Number(r.label)===0||Number(r.label)===1))outcomes.set(r.ticker,Number(r.label))});
    this.datasetMarkets=outcomes.size;this.datasetSnapshots=data.length;this.datasetYesMarkets=[...outcomes.values()].filter(x=>x===1).length;this.datasetNoMarkets=outcomes.size-this.datasetYesMarkets;this.datasetYesSnapshots=data.filter(r=>Number(r.label)===1).length;this.datasetNoSnapshots=data.length-this.datasetYesSnapshots;
    console.log(`[ML] Dataset: ${this.datasetMarkets} settled markets | YES=${this.datasetYesMarkets} (${this.datasetYesSnapshots} snapshots) | NO=${this.datasetNoMarkets} (${this.datasetNoSnapshots} snapshots)`);
    if(!this.datasetYesSnapshots||!this.datasetNoSnapshots){this.trainingStatus='SINGLE_CLASS';console.log('ML training deferred: dataset contains only one settlement class');return false;} if(data.length<50){this.trainingStatus='INSUFFICIENT_DATA';return false;}
    const split=this._chronologicalSplit(data);if(!split||split.trainData.length<25||!split.calibrationData.length||!split.testData.length){this.trainingStatus='INSUFFICIENT_DATA';return false;}
    const globalModel=this._fitStumpModel(split.trainData);const n=split.trainData[0].features.length;this.featureMeans=globalModel.means;this.featureStds=globalModel.stds;this.trees=globalModel.trees;
    this.trained=true;this.trainingSize=split.trainData.length;this.calibrationSize=split.calibrationData.length;this.testSize=split.testData.length;this.trainingMarkets=split.train.size;this.calibrationMarkets=split.calibration.size;this.testMarkets=split.test.size;this.validationSize=this.testSize;this.validationMarkets=this.testMarkets;this.modelVersion=`v2.6-${Date.now()}`;this.trainingStatus='CALIBRATING';this.calibration=this._fitCalibration(split.calibrationData);this.trainingStatus=this.calibration?'READY':'INSUFFICIENT_DATA';this.evaluation=this._evaluate(split.testData);this.specialists=this._trainSpecialists(split);this.residualModel=this._fitResidual(split);this.dataHealth=this._buildDataHealth(data,split);this.validationAccuracy=this.evaluation.raw.accuracy;this.validationBrier=this.evaluation.raw.brier;this.validationMarketAccuracy=this.evaluation.raw.market.accuracy;this.lastTrainedAt=new Date().toISOString();
    try { await this.challengers.train(this, data); } catch (e) { this.challengers.status='ERROR'; console.error('[Challenger] training failed:', e.message); }
    const importance=Array(n).fill(0);this.trees.forEach(tr=>importance[tr.feature]+=Math.abs(tr.leftPred-tr.rightPred));this.topFeatures=importance.map((imp,i)=>({index:i,name:this.featureNames[i]||`f${i}`,importance:imp})).sort((a,b)=>b.importance-a.importance).slice(0,8);
    console.log(`[ML] TRAIN: ${this.trainingMarkets} markets / ${this.trainingSize} snapshots | CALIBRATION: ${this.calibrationMarkets} / ${this.calibrationSize} | TEST: ${this.testMarkets} / ${this.testSize}`);if(this.calibration)console.log(`[ML] Calibration: a=${this.calibration.a.toFixed(4)} b=${this.calibration.b.toFixed(4)} on ${this.calibration.size} snapshots`);console.log('[ML] Top features:',this.topFeatures.map(f=>`${f.name}(${f.importance.toFixed(3)})`).join(', '));return true;
  }

  /**
   * Predict signal quality confidence [0, 1].
   * Higher = more likely to be a winning trade.
   */
  predict(features) {
    if (!this.trained || this.trees.length === 0) {
      return { confidence: 0.5, modelVersion: 'untrained' };
    }

    // Normalize features
    const xn = features.map((v, j) => (v - (this.featureMeans[j] || 0)) / (this.featureStds[j] || 1));

    // Sum predictions from all stumps
    let score = 0.5; // base prediction
    for (const tree of this.trees) {
      const pred = xn[tree.feature] < tree.threshold ? tree.leftPred : tree.rightPred;
      score += tree.weight * pred;
    }

    // Sigmoid to [0, 1]
    const confidence = 1 / (1 + Math.exp(-4 * (score - 0.5)));

    return {
      confidence: Math.max(0, Math.min(1, confidence)),
      modelVersion: this.modelVersion,
      rawScore: score,
    };
  }

  // ===== RAG Context Retrieval =====

  /**
   * Build a text summary of a trade for RAG embedding.
   */
  tradeToText(signal, outcome) {
    return [
      `Signal: ${signal.type} on ${signal.ticker}`,
      `Side: ${signal.side} at ${signal.priceCents}c`,
      `Edge: ${signal.edge.toFixed(1)}%, Model P: ${(signal.modelProb * 100).toFixed(0)}%`,
      `Reason: ${signal.reason}`,
      outcome ? `Outcome: ${outcome.won ? 'WON' : 'LOST'}, P&L: $${outcome.pnl.toFixed(2)}` : 'Pending',
    ].join(' | ');
  }

  /**
   * Get RAG context for a new signal by finding similar historical trades.
   * Returns a text summary of the most relevant past trades.
   */
  async getRAGContext(signal) {
    if (!supabase.enabled) return null;

    // Get recent signals of the same type for context
    const recent = await supabase.getRecentSignals(signal.ticker, 48);
    const perfStats = await supabase.getStrategyPerformance(7);

    if (recent.length === 0 && Object.keys(perfStats).length === 0) return null;

    const contextParts = [];

    // Strategy performance summary
    if (perfStats[signal.type]) {
      const s = perfStats[signal.type];
      const wr = s.count > 0 ? ((s.wins / s.count) * 100).toFixed(0) : '?';
      contextParts.push(`7-day ${signal.type} performance: ${s.count} trades, ${wr}% WR, P&L: $${s.pnl.toFixed(2)}`);
    }

    // Recent similar signals
    const similar = recent
      .filter(r => r.type === signal.type && r.outcome_won !== null)
      .slice(0, 5);

    if (similar.length > 0) {
      const wins = similar.filter(s => s.outcome_won).length;
      contextParts.push(`Recent ${signal.type} signals: ${wins}/${similar.length} won`);

      const avgEdge = similar.reduce((s, r) => s + (r.edge || 0), 0) / similar.length;
      contextParts.push(`Avg edge of recent signals: ${avgEdge.toFixed(1)}%`);
    }

    return contextParts.length > 0 ? contextParts.join('\n') : null;
  }

  // ===== Integration with Signal Generator =====

  /**
   * Score a signal and decide whether to boost, reduce, or block it.
   * Returns an adjustment factor [0, 2]:
   *   < 0.5: Block signal (ML says very unlikely to win)
   *   0.5-0.8: Reduce position size
   *   0.8-1.2: No adjustment (ML neutral)
   *   1.2-1.5: Boost position size
   *   > 1.5: Strong boost (ML very confident)
   */
  async scoreSignal(signal, marketContext) {
    const features = this.extractFeatures(signal, marketContext);
    const prediction = this.predict(features);
    const calibratedProbability = this.calibrateProbability(prediction.confidence);
    const kalshiYesProbability = Number.isFinite(marketContext.yesAsk) ? marketContext.yesAsk : null;
    const secondsRemaining = Number(marketContext.timeRemainingMs) / 1000;
    const regime = secondsRemaining >= 300 ? 'EARLY' : secondsRemaining >= 120 ? 'LATE' : secondsRemaining >= 0 ? 'FINAL' : null;
    const specialist = regime ? this.specialists?.[regime] : null;
    const specialistRaw = specialist?.model ? this._predictStumpModel(specialist.model, features) : null;
    const specialistCalibrated = specialistRaw == null ? null : this._applyCalibration(specialistRaw, specialist.calibration);
    let residualProbability = null;
    if (this.residualModel && Number.isFinite(kalshiYesProbability) && kalshiYesProbability > 0 && kalshiYesProbability < 1 && Number.isFinite(this.residualModel.a)) {
      const k = this._clip(kalshiYesProbability), x = Math.log(k / (1-k));
      const residualRaw = this._clip(1/(1+Math.exp(-(this.residualModel.a*x+this.residualModel.b))));
      residualProbability = this._applyCalibration(residualRaw, this.residualModel.calibration);
    }
    this.liveShadow = { rawProbability: prediction.confidence, calibratedProbability, kalshiYesProbability, calibratedEdge: kalshiYesProbability == null ? null : calibratedProbability - kalshiYesProbability, agreement: kalshiYesProbability == null ? null : ((calibratedProbability >= 0.5) === (kalshiYesProbability >= 0.5)), ticker: signal.ticker || null, regime, specialistProbability: specialistCalibrated, residualProbability };
    const challengerShadow = this.challengers.score(this,{ticker:signal.ticker||null,timestamp:new Date().toISOString(),regime,features,kalshiProbability:kalshiYesProbability});
    if (challengerShadow) this.liveShadow.challenger = challengerShadow;
    const ragContext = await this.getRAGContext(signal);

    // Do not persist training observations here. Scoring can happen repeatedly
    // for signals that never trade. The order executor persists exactly one
    // observation after a confirmed fill, keyed by the Kalshi order id.

    // Log prediction
    if (this.trained) {
      await supabase.logPrediction({
        signalId: null,
        modelVersion: this.modelVersion,
        confidence: prediction.confidence,
        predictedOutcome: prediction.confidence > 0.5 ? 1 : 0,
        featuresHash: features.slice(0, 5).map(f => f.toFixed(2)).join(','),
      });
    }

    // Calculate adjustment factor
    let adjustment = 1.0;
    if (this.trained) {
      // Map confidence to adjustment: 0.3 → 0.5x, 0.5 → 1.0x, 0.7 → 1.5x
      adjustment = 0.5 + (prediction.confidence - 0.3) * (1.5 / 0.4);
      adjustment = Math.max(0.3, Math.min(2.0, adjustment));
    }

    return {
      adjustment,
      confidence: prediction.confidence,
      modelVersion: prediction.modelVersion,
      ragContext,
      shouldBlock: adjustment < 0.5,
      features,
    };
  }

  /**
   * Record the outcome of a trade for the feedback loop.
   * Call this after settlement to update training data.
   */
  async recordOutcome(signalId, won, pnl) {
    await supabase.updateSignalOutcome(signalId, { won, pnl });
  }

  describe() {
    return {
      trained: this.trained,
      modelVersion: this.modelVersion,
      trainingSize: this.trainingSize,
      validationSize: this.validationSize,
      validationAccuracy: this.validationAccuracy,
      validationBrier: this.validationBrier,
      validationMarketAccuracy: this.validationMarketAccuracy,
      datasetMarkets: this.datasetMarkets,
      datasetSnapshots: this.datasetSnapshots,
      datasetYesMarkets: this.datasetYesMarkets,
      datasetNoMarkets: this.datasetNoMarkets,
      datasetYesSnapshots: this.datasetYesSnapshots,
      datasetNoSnapshots: this.datasetNoSnapshots,
      trainingMarkets: this.trainingMarkets,
      validationMarkets: this.validationMarkets,
      calibrationMarkets: this.calibrationMarkets,
      testMarkets: this.testMarkets,
      calibrationSize: this.calibrationSize,
      testSize: this.testSize,
      calibration: this.calibration,
      evaluation: this.evaluation,
      specialists: Object.fromEntries(Object.entries(this.specialists || {}).map(([k,v]) => [k, {...v, model: undefined}])),
      residualModel: this.residualModel,
      dataHealth: this.dataHealth,
      topFeatures: this.topFeatures,
      liveShadow: this.liveShadow,
      challengers: this.challengers.describe(),
      shadowOnly: true,
      lastTrainedAt: this.lastTrainedAt,
      trainingStatus: this.trainingStatus,
      trees: this.trees.length,
      features: this.featureNames.length,
    };
  }
}

// Singleton
const pipeline = new MLPipeline();
module.exports = pipeline;
