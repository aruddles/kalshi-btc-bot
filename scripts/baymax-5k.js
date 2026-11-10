'use strict';
const fs=require('fs');const path=require('path');const supabase=require('../lib/supabase');
const B=require('../lib/baymax-5k');
function arg(n,d){const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:d;}
const historicalFile=arg('--historical','data/historical-ml-v3-5000-markets.jsonl');
const incumbentFile=arg('--incumbent','data/final-challenger-1k-model.json');
const snapshotFile=arg('--snapshot','data/models/baymax-final-5k.json');
const outFile=arg('--out','data/baymax-5k/summary.json');
(async()=>{try{
 const historical=B.loadHistorical5k(historicalFile);if(historical.status!=='READY')throw new Error(`Baymax-5K ${historical.status}: ${historical.error||historicalFile}`);
 if(historical.report.markets!==4989)console.warn(`[BAYMAX-5K] Dataset has ${historical.report.markets} markets (validated reference is 4989); continuing with explicit identity/fingerprint.`);
 if(!fs.existsSync(incumbentFile))throw new Error(`Frozen FINAL_CHALLENGER_1K snapshot missing: ${incumbentFile}`);const incumbent=JSON.parse(fs.readFileSync(incumbentFile,'utf8'));
 supabase.initialize();const live=await supabase.getTrainingData();if(!live.length)throw new Error('No settled Grade-A live data available; configure Supabase. Baymax-5K will not fabricate a holdout.');
 const projected=B.projectLiveFinal(live,historical.report.dateRange.last),split=B.splitLiveHoldout(projected);if(!split||!split.calibrationRows.length||!split.testRows.length)throw new Error('Insufficient newer Grade-A whole-ticker data for train/calibration/test comparison');
 B.assertLeakageSafe(split,new Set(historical.rows.map(r=>r.ticker)));
 const fitted=B.loadOrTrain({snapshotFile,historicalFile,historical,split});const comparison=B.compare({incumbent,challenger:fitted.snapshot,testRows:split.testRows});const summary=B.buildSummary({incumbent,challenger:fitted.snapshot,historical,split,comparison,reused:fitted.reused});fs.mkdirSync(path.dirname(outFile),{recursive:true});fs.writeFileSync(outFile,JSON.stringify(summary,null,2));
 console.log('FINAL DATA SCALING LAB — BAYMAX 1K vs 5K\n========================================');console.log(`5K historical markets: ${historical.report.markets}`);console.log(`5K snapshot: ${fitted.reused?'REUSED':'TRAINED'} ${fitted.snapshot.fingerprint}`);console.log(`Untouched Grade-A test: ${comparison.test.markets} markets / ${comparison.test.observations} observations`);console.log(`Date range: ${comparison.test.dateRange.first||'--'} -> ${comparison.test.dateRange.last||'--'}`);console.log('\nMODEL                 ACCURACY    BRIER      LOG LOSS');for(const [n,x] of [['BAYMAX_FINAL_1K',comparison.baymax1k],['BAYMAX_FINAL_5K',comparison.baymax5k],['KALSHI',comparison.kalshi]])console.log(`${n.padEnd(21)} ${x.accuracy==null?'--':(x.accuracy*100).toFixed(1)+'%'}      ${x.brier==null?'--':x.brier.toFixed(4)}     ${x.logLoss==null?'--':x.logLoss.toFixed(4)}`);console.log(`\n5K vs 1K Brier improvement: ${comparison.improvement.brier5kVs1k==null?'--':(comparison.improvement.brier5kVs1k*100).toFixed(2)+'%'}`);console.log(`5K vs 1K log-loss improvement: ${comparison.improvement.logLoss5kVs1k==null?'--':(comparison.improvement.logLoss5kVs1k*100).toFixed(2)+'%'}`);console.log(`Summary: ${outFile}`);
 }catch(e){console.error(`[BAYMAX-5K] ${e.message}`);process.exitCode=1;}})();
