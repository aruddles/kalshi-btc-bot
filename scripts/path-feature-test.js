'use strict';
// Offline, read-only: npm run path-feature-test -> data/path-feature-test/summary.json
const fs = require('fs'), path = require('path');
const P = require('../lib/path-feature-test');
const pipeline = require('../lib/ml-pipeline');
const file = process.argv[2] || 'data/historical-ml-v4-5000-markets.jsonl';
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const r = P.run(rows, pipeline);
fs.mkdirSync('data/path-feature-test', { recursive: true });
fs.writeFileSync('data/path-feature-test/summary.json', JSON.stringify({ ...r, dataset: path.basename(file), runTimestamp: new Date().toISOString() }, null, 2));
const f = x => (x == null ? '--' : x.toFixed(5));
console.log(`PATH-FEATURE TEST — train ${r.trainMarkets} / test ${r.testMarkets} markets (${r.testObservations} test snapshots)`);
if (r.brier) {
  console.log(`Brier  Kalshi mid ${f(r.brier.kalshiMid)} | baseline ${f(r.brier.baseline)} | +path ${f(r.brier.path)}`);
  if (r.pathMinusBaselineCI) console.log(`+path minus baseline 95% CI: [${f(r.pathMinusBaselineCI.low)}, ${f(r.pathMinusBaselineCI.high)}]`);
  for (const [k, v] of Object.entries(r.regimes)) if (v) console.log(`  ${k.padEnd(5)} n=${v.n}  kalshi ${f(v.kalshi)}  base ${f(v.base)}  path ${f(v.path)}`);
}
console.log(`STATUS: ${r.status}`);
