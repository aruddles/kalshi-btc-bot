'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateVolatility, DEFAULT_SIGMA_15M } = require('../lib/volatility');
const { HistoricalDatasetBuilder } = require('../lib/historical-dataset-builder');

function path(n, sigmaPerSec, { start = 0, step = 1000, seed = 7 } = {}) {
  let x = seed, p = 100000; const out = [];
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    if (i) p *= Math.exp(sigmaPerSec * Math.sqrt(step / 1000) * z);
    out.push({ price: p, timestamp: start + i * step });
  }
  return out;
}

test('falls back to the default when history is too short', () => {
  assert.equal(estimateVolatility([], 900, { now: 0 }), DEFAULT_SIGMA_15M);
});

test('recovers the true volatility on a constant-vol path', () => {
  const s = 3e-5, h = path(3600, s);
  const est = estimateVolatility(h, 900, { now: 3600 * 1000 });
  assert.ok(Math.abs(est / (s * 30) - 1) < 0.1, `est=${est}`);
});

test('a feed gap is counted at its real duration', () => {
  const s = 3e-5, h = path(1800, s, { step: 2000 });
  const est = estimateVolatility(h, 900, { now: 3600 * 1000 });
  assert.ok(Math.abs(est / (s * 30) - 1) < 0.1, `est=${est}`);
});

test('shrinks a short-window vol spike toward the longer history', () => {
  const calm = path(2700, 2e-5), last = calm[calm.length - 1];
  const spike = path(901, 8e-5, { start: last.timestamp, seed: 11 }).slice(1)
    .map(s => ({ ...s, price: s.price * last.price / 100000 }));
  const h = [...calm, ...spike], now = h[h.length - 1].timestamp;
  const blended = estimateVolatility(h, 900, { now });
  const shortOnly = estimateVolatility(h, 900, { now, shortWeight: 1 });
  assert.ok(blended < shortOnly * 0.9 && blended > 2e-5 * 30, `blended=${blended} short=${shortOnly}`);
});

test('historical builder never uses a BTC candle that closes after the snapshot', () => {
  const close = Date.UTC(2026, 0, 1, 0, 15), open = close - 900000;
  const btc = [];
  for (let t = open - 600000; t < close; t += 60000) btc.push([t / 1000, 0, 0, 0, 50000 + (t - open) / 60000, 1]);
  const kc = [];
  for (let t = open; t <= close; t += 60000) kc.push({ end_period_ts: t / 1000, yes_bid: { close_dollars: '0.50' }, yes_ask: { close_dollars: '0.52' } });
  const market = { ticker: 'KXBTC15M-TEST', open_time: new Date(open).toISOString(), close_time: new Date(close).toISOString(), result: 'yes', floor_strike: 50000 };
  const { rows } = new HistoricalDatasetBuilder({}).reconstructMarket(market, kc, btc);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    const snapMs = Date.parse(r.ts);
    const candleClose = open + (r.metadata.btc_price - 50000) * 60000 + 60000; // price encodes candle start
    assert.ok(candleClose <= snapMs, `${r.ts}: used candle closing at ${new Date(candleClose).toISOString()}`);
  }
});
