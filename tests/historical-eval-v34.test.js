'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/historical-eval');

function row(ticker, ts, label, { bid = 0.48, ask = 0.5, t = 300, btc = 70000, target = 70000, vol = 0.25 } = {}) {
  const features = Array(27).fill(0); features[5] = vol;
  return { ticker, ts: new Date(ts).toISOString(), label, specialist_regime: 'LATE', features,
    metadata: { kalshi_yes_bid: bid, kalshi_yes_ask: ask, time_remaining_s: t, btc_price: btc, target_price: target } };
}

test('logistic regression recovers known coefficients', () => {
  let s = 3; const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const X = [], y = [];
  for (let i = 0; i < 20000; i++) { const x = rand() * 4 - 2; X.push([1, x]); y.push(rand() < H.sigmoid(0.5 + 1.5 * x) ? 1 : 0); }
  const w = H.fitLogistic(X, y);
  assert.ok(Math.abs(w[0] - 0.5) < 0.08 && Math.abs(w[1] - 1.5) < 0.1, `w=${w}`);
});

test('chronological split keeps markets whole and in time order', () => {
  const rows = [];
  for (let m = 0; m < 10; m++) for (let k = 0; k < 3; k++) rows.push(row(`M${m}`, m * 1e6 + k * 1000, m % 2));
  const sp = H.chronologicalSplit(rows, [0.5, 0.1, 0.4]);
  assert.deepEqual([...sp.tickers[0]], ['M0', 'M1', 'M2', 'M3', 'M4']);
  assert.deepEqual([...sp.tickers[1]], ['M5']);
  assert.deepEqual([...sp.tickers[2]], ['M6', 'M7', 'M8', 'M9']);
  assert.equal(sp.train.length + sp.calibration.length + sp.test.length, rows.length);
});

test('trade simulation takes one trade per market at the ask, after fees', () => {
  const rows = [row('A', 0, 1), row('A', 1000, 1), row('B', 0, 0, { bid: 0.6, ask: 0.62 })];
  // Model says 70% YES everywhere: A buys YES at 50c (fee 2c); B buys YES at 62c (fee 2c) and loses.
  const r = H.simulateTrades(rows, rows.map(() => 0.7), { minEv: 0 });
  assert.equal(r.trades, 2);
  assert.ok(Math.abs(r.totalPnl - ((1 - 0.5 - 0.02) + (0 - 0.62 - 0.02))) < 1e-9);
  assert.equal(H.simulateTrades(rows, rows.map(H.kalshiMid), { minEv: 0 }).trades, 0, 'pricing at the mid never pays the spread');
});

test('NO side uses 1 - YES bid as its ask', () => {
  const r = H.simulateTrades([row('C', 0, 0, { bid: 0.6, ask: 0.62 })], [0.1], { minEv: 0 });
  assert.equal(r.trades, 1);
  assert.ok(Math.abs(r.totalPnl - (1 - 0.4 - 0.02)) < 1e-9);
});

test('bootstrap CIs bracket the mean; leaky rows are refused', () => {
  const b = H.bootstrapMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(b.mean, 5.5);
  assert.ok(b.lo < 5.5 && b.hi > 5.5);
  const rows = [row('A', 0, 1), row('B', 0, 0)];
  const d = H.bootstrapDelta(rows, [0.9, 0.1], [0.5, 0.5]);
  assert.ok(d.delta < 0 && d.hi <= 0);
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heval-')), 'x.jsonl');
  fs.writeFileSync(f, JSON.stringify({ ...row('A', 0, 1), collector_version: 'historical-builder-v1' }) + '\n');
  assert.throws(() => H.loadRows(f), /lookahead leak/);
  assert.equal(H.loadRows(f, { allowLeaky: true }).length, 1);
});
