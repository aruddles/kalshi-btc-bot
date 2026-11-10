'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {HistoricalDatasetBuilder,normalizeKalshiCandle,marketTarget,UNAVAILABLE_FEATURES}=require('../lib/historical-dataset-builder');

const close=Date.parse('2026-10-01T12:15:00Z');
const market={ticker:'KXBTC15M-X',open_time:'2026-10-01T12:00:00Z',close_time:'2026-10-01T12:15:00Z',floor_strike:70000,result:'yes'};
function btc(){const a=[];for(let i=-6;i<=15;i++)a.push([(Date.parse('2026-10-01T12:00:00Z')+i*60000)/1000,69900+i,70100+i,70000+i,70020+i,10]);return a;}
function kc(){const a=[];for(let m=0;m<=15;m++){const ts=Date.parse('2026-10-01T12:00:00Z')+m*60000;a.push({end_period_ts:ts/1000,yes_bid:{close:'0.49'},yes_ask:{close:'0.51'},price:{close:'0.50'},volume:10});}return a;}

test('historical observation IDs are deterministic and minute-bucketed',()=>{const a=HistoricalDatasetBuilder.observationId('T',100001),b=HistoricalDatasetBuilder.observationId('T',119999);assert.equal(a,b);assert.match(a,/^historical:T:/)});
test('market target uses explicit strike before title parsing',()=>assert.equal(marketTarget({...market,title:'BTC $99,999'}),70000));
test('historical candle parser accepts archived plain close fields',()=>{const x=normalizeKalshiCandle({end_period_ts:100,yes_bid:{close:'0.44'},yes_ask:{close:'0.46'},price:{close:'0.45'}});assert.equal(x.yesBid,.44);assert.equal(x.yesAsk,.46)});
test('reconstruction labels YES/NO only from actual market settlement and marks unavailable strategy features',()=>{const b=new HistoricalDatasetBuilder();const out=b.reconstructMarket(market,kc(),btc());assert.ok(out.rows.length>=5);assert.ok(out.rows.every(r=>r.label===1&&r.settled_result==='yes'));assert.ok(out.rows.every(r=>r.quality_grade==='B'&&r.source==='historical'));assert.deepEqual(out.rows[0].unavailable_features,UNAVAILABLE_FEATURES);assert.equal(out.rows[0].metadata.orderbook_depth_available,false)});
test('unresolved market is never labeled or reconstructed',()=>{const b=new HistoricalDatasetBuilder();const out=b.reconstructMarket({...market,result:''},kc(),btc());assert.equal(out.rows.length,0);assert.equal(out.skip,'unresolved')});
test('specialist-aligned samples cover EARLY LATE FINAL without future timestamps',()=>{const b=new HistoricalDatasetBuilder();const rows=b.reconstructMarket(market,kc(),btc()).rows;const regimes=new Set(rows.map(r=>r.specialist_regime));assert.deepEqual([...regimes].sort(),['EARLY','FINAL','LATE']);assert.ok(rows.every(r=>Date.parse(r.ts)<close));});
test('dry run never writes staging',async()=>{let writes=0;const builder=new HistoricalDatasetBuilder({kalshi:{candles:async()=>kc()},btc:{candles:async()=>btc()},staging:{upsert:async()=>{writes++}}});const r=await builder.run({markets:[market],dryRun:true});assert.equal(writes,0);assert.ok(r.rows.length>0);});
test('write mode uses staging only',async()=>{let got=[];const builder=new HistoricalDatasetBuilder({kalshi:{candles:async()=>kc()},btc:{candles:async()=>btc()},staging:{upsert:async rows=>{got=rows}}});const r=await builder.run({markets:[market],dryRun:false});assert.equal(got.length,r.rows.length);assert.ok(got.every(x=>x.source==='historical'));});
test('quality report exposes zero historical depth coverage and class balance',()=>{const b=new HistoricalDatasetBuilder();const rows=b.reconstructMarket(market,kc(),btc()).rows;const q=b.qualityReport(rows,1,{});assert.equal(q.marketsReconstructed,1);assert.equal(q.yesMarkets,1);assert.equal(q.orderbookDepthCoverage,0);assert.ok(q.unavailableFeatures.includes('model_prob'));});
