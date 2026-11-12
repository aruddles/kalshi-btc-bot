const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/path-feature-test');
const pipeline = require('../lib/ml-pipeline');

function row(ticker, ts, t, btc, bid, label) {
  return { ticker, ts, label, features: Array.from({ length: 27 }, (_, i) => (i === 3 ? t / 900 : i === 9 ? bid + .01 : 0.1)), metadata: { time_remaining_s: t, btc_price: btc, kalshi_yes_bid: bid, kalshi_yes_ask: bid + .02 } };
}

test('path features use only earlier snapshots of the same market', () => {
  const rows = [row('A', '2026-01-01T00:00:00Z', 720, 100000, .5, 1), row('A', '2026-01-01T00:02:00Z', 600, 100100, .55, 1), row('A', '2026-01-01T00:04:00Z', 480, 100200, .6, 1)];
  const b = P.build(rows).sort((x, y) => y.t - x.t);
  assert.deepEqual(b[0].path, [0, 0, 0, 0, 0]);
  assert.ok(Math.abs(b[1].path[0] - 1) < 1e-9);
  assert.equal(b[1].path[4], 0);
  assert.equal(b[2].path[4], 1);
  assert.ok(b[2].path[2] > 0);
});

test('split keeps whole markets and time order', () => {
  const rows = []; for (let m = 0; m < 10; m++) for (let k = 0; k < 3; k++) rows.push({ ticker: 'M' + m, ts: new Date(m * 1e6 + k).toISOString() });
  const s = P.split(rows);
  assert.equal(s.trainMarkets, 7);
  assert.ok(s.test.every(r => Number(r.ticker.slice(1)) >= 7));
});

test('a path that truly predicts the outcome is detected; small data is refused', () => {
  let s = 3; const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const rows = [];
  for (let m = 0; m < 400; m++) { const y = rnd() < .5 ? 1 : 0; let btc = 100000;
    for (let k = 0; k < 8; k++) { btc += (y ? 30 : -30) * (rnd() < .8 ? 1 : -1); rows.push(row('M' + m, new Date(m * 1e6 + k * 120000).toISOString(), 840 - k * 120, btc, .49, y)); } }
  const r = P.run(rows, pipeline);
  assert.equal(r.status, 'PATH_HELPS');
  assert.equal(P.run(rows.slice(0, 40), pipeline).status, 'INSUFFICIENT_DATA');
});
