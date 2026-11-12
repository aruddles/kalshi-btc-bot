'use strict';
// Durable exit-vs-hold counterfactual log (one JSON line per take-profit exit).
// Diagnostic only: never changes cash, P&L, labels, or trading behavior.
//
// Pre-registered test (frozen 2026-11-12, before any logged data):
//   Data: TAKE_PROFIT exits logged from LOGGED_SINCE onward, all modes.
//   Metric: delta = early-exit P&L - hold-to-settlement P&L, per exit.
//   Decision after >= MIN_EXITS exits: market-clustered bootstrap 95% CI of mean delta.
//     CI entirely < 0  -> HOLDING_BETTER   (early exits cost money)
//     CI entirely > 0  -> EARLY_EXIT_BETTER
//     otherwise        -> NO_SIGNIFICANT_DIFFERENCE
//   The 78-exit discovery sample (2026-11-10..11, holding +$40 better) is excluded.
const fs = require('fs');
const path = require('path');
const { bootstrap } = require('./final-precision-oos');

const MIN_EXITS = 300;
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'exit-vs-hold.jsonl');
const file = () => process.env.EXIT_HOLD_LOG || DEFAULT_FILE;
// Under `node --test`, write only when a test points EXIT_HOLD_LOG at a temp file,
// so test runs never add fake rows to the real log.
const enabled = () => !process.env.NODE_TEST_CONTEXT || !!process.env.EXIT_HOLD_LOG;

function append(row) {
  if (!enabled()) return;
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(row) + '\n');
}

function load(f = file()) {
  if (!fs.existsSync(f)) return [];
  const seen = new Set(), out = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.orderId || seen.has(r.orderId) || !Number.isFinite(r.delta)) continue;
    seen.add(r.orderId); out.push(r);
  }
  return out;
}

function summarize(rows) {
  const n = rows.length, sum = rows.reduce((s, r) => s + r.delta, 0);
  const res = { exits: n, markets: new Set(rows.map(r => r.ticker)).size, minExits: MIN_EXITS,
    earlyExitPnl: rows.reduce((s, r) => s + r.pnl, 0), holdPnl: rows.reduce((s, r) => s + r.holdPnl, 0),
    totalDelta: sum, meanDelta: n ? sum / n : null, wouldHaveLost: rows.filter(r => r.holdPnl < 0).length, ci95: null, status: 'INSUFFICIENT_DATA' };
  if (n >= MIN_EXITS) {
    res.ci95 = bootstrap(rows, a => a.reduce((s, r) => s + r.delta, 0) / a.length, 1000, 20261112);
    if (res.ci95) res.status = res.ci95.high < 0 ? 'HOLDING_BETTER' : res.ci95.low > 0 ? 'EARLY_EXIT_BETTER' : 'NO_SIGNIFICANT_DIFFERENCE';
  }
  return res;
}

module.exports = { MIN_EXITS, DEFAULT_FILE, append, load, summarize };
