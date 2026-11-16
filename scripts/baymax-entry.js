#!/usr/bin/env node
// Pre-registered BAYMAX_ENTRY_V1 test (rules in lib/baymax-entry.js). Read-only.
const fs = require('fs');
const path = require('path');
const { evaluate, REGISTERED_AT } = require('../lib/baymax-entry');
const { load } = require('../lib/trade-log');

const file = process.argv[2] || 'data/trades.jsonl';
const res = evaluate(load(file));
const c = res.counts;
console.log(`BAYMAX_ENTRY_V1 (pre-registered ${new Date(REGISTERED_AT).toISOString()}) — judge model for the main bot's entries`);
if (res.status === 'INSUFFICIENT_TRAINING_DATA') { console.log(`STATUS: ${res.status} (${c.train} training trades)`); process.exit(0); }
console.log(`Training: ${c.train} trades / ${c.trainMarkets} markets | model ${res.fingerprint} | excluded rows: ${c.excluded}`);
console.log(`Forward test: ${c.test}/${c.needed.MIN_TEST} trades, ${c.testMarkets}/${c.needed.MIN_MARKETS} markets | SKIP ${c.skip}/${c.needed.MIN_SKIP} | TAKE ${c.take}`);
if (res.status === 'INSUFFICIENT_DATA') {
  console.log('STATUS: INSUFFICIENT_DATA — counts only; results stay unseen until the threshold.');
} else {
  const pct = x => (x * 100).toFixed(2) + '%', $ = x => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
  console.log(`SKIP trades: return/$ ${pct(res.skipMeanReturn)}, win ${pct(res.skipWinRate)} | TAKE trades: return/$ ${pct(res.takeMeanReturn)}, win ${pct(res.takeWinRate)}`);
  console.log(`SKIP - TAKE: ${pct(res.diff)} (95% CI ${pct(res.ci.low)} to ${pct(res.ci.high)})`);
  console.log(`P&L all: ${$(res.pnlAll)} | TAKE only: ${$(res.pnlTakeOnly)} | skipped trades: ${$(res.pnlSkipped)}`);
  console.log(`STATUS: ${res.status}`);
}
const out = 'data/baymax-entry/summary.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ...res, file, runTimestamp: new Date().toISOString() }, null, 2));
