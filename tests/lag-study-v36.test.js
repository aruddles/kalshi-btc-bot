'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/lag-study');

// Synthetic capture: BTC jumps $40 every 60s (alternating up/down); Kalshi's YES mid
// steps 10c the same way exactly `lagMs` later. Quotes are re-sent every second.
const OPEN = 1_800_000_000_000;
function capture({ lagMs = 1500, jumps = 8, gapAt = null } = {}) {
  const ev = [], close = OPEN + 900_000;
  const push = (type, t, payload) => ev.push({ type, received_at_ms: t, payload });
  const jumpTimes = Array.from({ length: jumps }, (_, i) => OPEN + 60_000 + i * 60_000);
  const level = (t, delay) => jumpTimes.filter(j => j + delay <= t).reduce((acc, _, i) => acc + (i % 2 ? -1 : 1), 0);
  const quote = (t, m) => push('derived_quote', t, { ticker: 'K', quotes: {
    yesBid: { price: +(m - 0.01).toFixed(2), quantity: 10 }, yesAsk: { price: +(m + 0.01).toFixed(2), quantity: 10 },
    noBid: { price: +(1 - m - 0.01).toFixed(2), quantity: 10 }, noAsk: { price: +(1 - m + 0.01).toFixed(2), quantity: 10 } } });
  push('market_metadata', OPEN, { ticker: 'K', open_time: new Date(OPEN).toISOString(), close_time: new Date(close).toISOString(), floor_strike: 70000 });
  const end = OPEN + 60_000 + jumps * 60_000;
  for (let t = OPEN; t < end; t += 100) {
    const price = 70000 + 40 * level(t, 0);
    if (t % 200 === 0) for (const venue of ['coinbase', 'kraken', 'bitstamp']) push('usd_reference_quote', t, { venue, mid: price, bid: price - 0.5, ask: price + 0.5 });
    const mid = +(0.5 + 0.1 * level(t, lagMs)).toFixed(2);
    const changed = jumpTimes.some(j => j + lagMs === t);
    if (t % 1000 === 0 || changed) quote(t, mid);
  }
  if (gapAt != null) push('sequence_gap', OPEN + gapAt, { ticker: 'K' });
  push('market_settlement', close + 1000, { ticker: 'K', result: 'yes' });
  return ev.sort((x, y) => x.received_at_ms - y.received_at_ms);
}

test('detects BTC jumps from the composite and measures Kalshi response time', () => {
  const r = L.analyze(capture({ lagMs: 1500 }), { cooldownMs: 10_000 });
  assert.equal(r.coverage.jumps, 8);
  assert.equal(r.coverage.usableEvents, 8);
  assert.equal(r.response.medianMs, 1500);
  assert.equal(r.response.respondedWithin.ms1000, 0);
  assert.equal(r.response.respondedWithin.ms2000, 1);
});

test('markout pays for buying before Kalshi reprices and not after', () => {
  const r = L.analyze(capture({ lagMs: 1500 }), { cooldownMs: 10_000 });
  const at = ms => r.markout.find(m => m.latencyMs === ms);
  // Buy at the stale ask (mid 0.50 -> ask 0.51), worth 0.60 thirty seconds later, minus a 2c fee.
  assert.ok(Math.abs(at(0).markoutPnl.mean - 0.07) < 1e-9, `${at(0).markoutPnl.mean}`);
  assert.equal(at(0).passes, true);
  assert.ok(at(2000).markoutPnl.mean < 0, 'after Kalshi reprices, crossing the spread and paying the fee loses');
  assert.equal(at(2000).passes, false);
});

test('an instantly repricing book shows no lag and no edge', () => {
  const r = L.analyze(capture({ lagMs: 0 }), { cooldownMs: 10_000 });
  assert.equal(r.response.respondedWithin.ms0, 1);
  assert.equal(r.markout.find(m => m.latencyMs === 0).passes, false);
});

test('cross-correlation peaks at the lag', () => {
  const r = L.analyze(capture({ lagMs: 2000 }), { cooldownMs: 10_000 });
  const best = r.crossCorrelation.filter(x => x.corr != null).sort((a, b) => b.corr - a.corr)[0];
  assert.equal(best.lagSec, 2);
});

test('quotes after a sequence gap are ignored until a fresh snapshot', () => {
  const ev = capture({ gapAt: 30_000 });
  const qs = L.buildSeries(ev).quotes.get('K');
  assert.ok(qs.length > 0 && qs.every(q => q.t <= OPEN + 30_000), 'no quotes accepted after the gap without a snapshot');
  ev.push({ type: 'kalshi_ws', received_at_ms: OPEN + 40_000, payload: { type: 'orderbook_snapshot', msg: { market_ticker: 'K' } } });
  ev.sort((x, y) => x.received_at_ms - y.received_at_ms);
  assert.ok(L.buildSeries(ev).quotes.get('K').some(q => q.t > OPEN + 40_000), 'quotes resume after the snapshot');
});
