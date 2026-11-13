#!/usr/bin/env node
// Pre-registered quiet-hours test (rules in lib/quiet-hours.js). Read-only.
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../lib/quiet-hours');

const file = process.argv[2] || 'data/trades.jsonl';
const out = 'data/quiet-hours/summary.json';
const trades = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const res = evaluate(trades);
const row = (name, s) => `${name.padEnd(6)} ${String(s.trades).padStart(6)} ${String(s.markets).padStart(8)} ${s.pnl.toFixed(2).padStart(9)} ${s.meanReturn == null ? '     --' : ((s.meanReturn * 100).toFixed(2) + '%').padStart(7)} ${s.winRate == null ? '   --' : ((s.winRate * 100).toFixed(1) + '%').padStart(6)}`;
console.log('QUIET HOURS (pre-registered) — quiet = weekends + weekdays 8 PM-8 AM ET');
console.log('BUCKET  TRADES  MARKETS       P&L  RET/$    WIN');
console.log(row('quiet', res.quiet));
console.log(row('busy', res.busy));
console.log(`Weekend trades: ${res.weekendTrades}`);
if (res.diff != null) console.log(`Quiet - busy return/$: ${(res.diff * 100).toFixed(2)} pts` + (res.ci ? ` (95% CI ${(res.ci.low * 100).toFixed(2)} to ${(res.ci.high * 100).toFixed(2)})` : ''));
console.log(`STATUS: ${res.status}${res.status === 'INSUFFICIENT_DATA' ? ` (need >=${res.thresholds.MIN_TRADES} trades & >=${res.thresholds.MIN_MARKETS} markets per bucket, >=${res.thresholds.MIN_WEEKEND} weekend trades) — interim only, no decisions` : ''}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ...res, file, runTimestamp: new Date().toISOString() }, null, 2));
