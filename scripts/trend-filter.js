#!/usr/bin/env node
// Pre-registered trend-filter test (rules in lib/trend-filter.js). Read-only.
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../lib/trend-filter');

const file = process.argv[2] || 'data/trades.jsonl';
const trades = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const res = evaluate(trades);
const c = res.counts;
console.log('TREND FILTER (pre-registered) — counter-trend = YES in 1H BEARISH or NO in 1H BULLISH');
console.log(`Trades since registration: ${c.tradesSinceRegistration} | counter-trend: ${c.counterTrend}/${c.needed.MIN_TRADES} across ${c.counterMarkets}/${c.needed.MIN_MARKETS} markets | unlabeled: ${c.unlabeled}`);
if (res.status === 'INSUFFICIENT_DATA') {
  console.log('STATUS: INSUFFICIENT_DATA — counts only; P&L stays unseen until the threshold.');
} else {
  const $ = x => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
  console.log(`Counter-trend return/$: ${(res.counterMeanReturn * 100).toFixed(2)}% (95% CI ${(res.ci.low * 100).toFixed(2)} to ${(res.ci.high * 100).toFixed(2)})`);
  console.log(`P&L all: ${$(res.pnlAll)} | without counter-trend: ${$(res.pnlWithoutCounterTrend)}`);
  console.log(`STATUS: ${res.status}`);
}
const out = 'data/trend-filter/summary.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ...res, file, runTimestamp: new Date().toISOString() }, null, 2));
