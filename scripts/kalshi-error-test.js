'use strict';
// Offline, read-only: npm run kalshi-error-test -> data/kalshi-error-test/summary.json
const fs = require('fs'), path = require('path');
const K = require('../lib/kalshi-error-test');
const file = process.argv[2] || 'data/historical-ml-v4-5000-markets.jsonl';
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const r = K.run(rows);
fs.mkdirSync('data/kalshi-error-test', { recursive: true });
fs.writeFileSync('data/kalshi-error-test/summary.json', JSON.stringify({ ...r, dataset: path.basename(file), runTimestamp: new Date().toISOString() }, null, 2));
const f = x => (x == null ? '--' : x.toFixed(5)), $ = x => (x == null ? '--' : (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(3));
console.log(`KALSHI-ERROR TEST — train ${r.trainMarkets} / test ${r.testMarkets} markets`);
if (r.brier) {
  console.log(`Brier  Kalshi mid ${f(r.brier.kalshiMid)} | Kalshi recal ${f(r.brier.kalshiRecal)} | Kalshi+path ${f(r.brier.kalshiPath)}`);
  if (r.pathMinusRecalCI) console.log(`path minus recal 95% CI: [${f(r.pathMinusRecalCI.low)}, ${f(r.pathMinusRecalCI.high)}]`);
  for (const [k, v] of Object.entries(r.regimes)) if (v) console.log(`  ${k.padEnd(5)} n=${v.n}  kalshi ${f(v.kalshi)}  recal ${f(v.recal)}  path ${f(v.path)}`);
  for (const [k, v] of Object.entries(r.secondaryTrades)) console.log(`Secondary trades (${k}): ${v.trades} trades, EV ${$(v.evPerTrade)}/trade, total ${$(v.totalPnl)}${v.ci ? `, EV CI [${$(v.ci.low)}, ${$(v.ci.high)}]` : ''}`);
}
console.log(`STATUS: ${r.status}`);
