const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/kalshi-error-test');

function row(ticker, ts, t, btc, bid, label) {
  return { ticker, ts, label, features: Array.from({ length: 27 }, (_, i) => (i === 3 ? t / 900 : i === 9 ? bid + .02 : 0.1)), metadata: { time_remaining_s: t, btc_price: btc, kalshi_yes_bid: bid, kalshi_yes_ask: bid + .02 } };
}
function rnd(seed) { let s = seed; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }

test('logistic fit recovers a simple relationship', () => {
  const r = rnd(1), X = [], y = [];
  for (let i = 0; i < 2000; i++) { const x = r() * 4 - 2; X.push([x]); y.push(r() < 1 / (1 + Math.exp(-2 * x)) ? 1 : 0); }
  const m = K.fitLogistic(X, y);
  assert.ok(m.predict([1.5]) > .85 && m.predict([-1.5]) < .15);
});

test('detects a path that predicts Kalshi mistakes; finds nothing when Kalshi is right', () => {
  const r = rnd(9), informative = [], efficient = [];
  for (let m = 0; m < 400; m++) {
    const y = r() < .5 ? 1 : 0; let btc = 100000;
    for (let k = 0; k < 8; k++) {
      btc += (y ? 25 : -25) * (r() < .8 ? 1 : -1);
      informative.push(row('M' + m, new Date(m * 1e6 + k * 120000).toISOString(), 840 - k * 120, btc, .49, y));      // Kalshi stuck at 50c
      efficient.push(row('M' + m, new Date(m * 1e6 + k * 120000).toISOString(), 840 - k * 120, btc, y ? .79 : .19, y)); // Kalshi already right
    }
  }
  assert.equal(K.run(informative).status, 'PATH_PREDICTS_KALSHI_ERROR');
  assert.notEqual(K.run(efficient).status, 'PATH_PREDICTS_KALSHI_ERROR');
});
