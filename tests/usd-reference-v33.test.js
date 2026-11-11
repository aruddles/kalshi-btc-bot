'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const R = require('../lib/reference-price');
const UsdReferenceFeed = require('../bot/usd-reference-feed');
const { settlementProbabilityFromReference } = require('../lib/settlement-model');
const E = require('../lib/settlement-shadow-eval');

// ---- venue parsers (message shapes captured from the live feeds) ----
test('parses Coinbase, Kraken v2 and Bitstamp top of book', () => {
  assert.deepEqual(R.parsers.coinbase({ type: 'ticker', product_id: 'BTC-USD', best_bid: '73927.80', best_ask: '73927.81' }), { bid: 73927.8, ask: 73927.81, mid: 73927.805 });
  assert.equal(R.parsers.coinbase({ type: 'subscriptions' }), null);
  assert.equal(R.parsers.coinbase({ type: 'ticker', product_id: 'ETH-USD', best_bid: '1', best_ask: '2' }), null);
  assert.equal(R.parsers.kraken({ channel: 'ticker', type: 'update', data: [{ symbol: 'BTC/USD', bid: 73910.0, ask: 73910.1 }] }).mid, 73910.05);
  assert.equal(R.parsers.kraken({ channel: 'status', data: [{}] }), null);
  assert.equal(R.parsers.bitstamp({ event: 'data', channel: 'order_book_btcusd', data: { bids: [['73932.99', '0.1']], asks: [['73933.01', '0.2']] } }).mid, 73933);
  assert.equal(R.parsers.bitstamp({ event: 'bts:subscription_succeeded', channel: 'order_book_btcusd', data: {} }), null);
  assert.equal(R.parsers.kraken({ channel: 'ticker', data: [{ symbol: 'BTC/USD', bid: 10, ask: 9 }] }), null, 'crossed book rejected');
});

// ---- composite ----
test('composite is the median of fresh venues', () => {
  const now = 100000;
  const c = R.compositePrice({ coinbase: { mid: 70000, ts: now }, kraken: { mid: 70020, ts: now }, bitstamp: { mid: 70010, ts: now } }, now);
  assert.equal(c.price, 70010);
  assert.deepEqual(c.venues, ['bitstamp', 'coinbase', 'kraken']);
  assert.equal(c.dispersion, 20);
});

test('stale venues and outliers are dropped; fewer than two venues gives no price', () => {
  const now = 100000;
  const stale = R.compositePrice({ coinbase: { mid: 100, ts: now }, kraken: { mid: 102, ts: now - 6000 }, bitstamp: { mid: 101, ts: now } }, now);
  assert.equal(stale.price, 100.5);
  const outlier = R.compositePrice({ coinbase: { mid: 70000, ts: now }, kraken: { mid: 70010, ts: now }, bitstamp: { mid: 72000, ts: now } }, now);
  assert.deepEqual(outlier.venues, ['coinbase', 'kraken']);
  assert.deepEqual(outlier.excluded, ['bitstamp']);
  assert.equal(R.compositePrice({ coinbase: { mid: 100, ts: now } }, now), null);
});

// ---- live feed with a fake socket ----
class FakeWs extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; FakeWs.all.push(this); }
  send(x) { this.sent.push(JSON.parse(x)); }
  terminate() { this.terminated = true; }
}
FakeWs.all = [];

test('feed subscribes on open, samples a composite and reports status', () => {
  FakeWs.all = [];
  let t = 1_000_000;
  const feed = new UsdReferenceFeed({ WebSocketImpl: FakeWs, now: () => t, logger: { warn() {} } });
  feed.start();
  try {
    assert.equal(FakeWs.all.length, 3);
    for (const ws of FakeWs.all) ws.emit('open');
    const byUrl = u => FakeWs.all.find(w => w.url.includes(u));
    assert.deepEqual(byUrl('coinbase').sent[0].channels, ['ticker']);
    assert.equal(byUrl('kraken').sent[0].params.event_trigger, 'bbo');
    byUrl('coinbase').emit('message', Buffer.from(JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', best_bid: '100', best_ask: '100.02' })));
    byUrl('kraken').emit('message', JSON.stringify({ channel: 'ticker', data: [{ symbol: 'BTC/USD', bid: 100.1, ask: 100.11 }] }));
    byUrl('bitstamp').emit('message', 'not json');
    const s = feed.sample();
    assert.ok(Math.abs(s.price - 100.0575) < 1e-9);
    assert.equal(feed.isHealthy(), true);
    t += 4000;
    assert.equal(feed.isHealthy(), false, 'stale composite is unhealthy');
    assert.equal(feed.getStatus().venues.bitstamp.mid, null);
  } finally { feed.stop(); }
});

test('Bitstamp reconnect request drops its quote and reconnects', () => {
  FakeWs.all = [];
  const feed = new UsdReferenceFeed({ venues: ['bitstamp'], WebSocketImpl: FakeWs, logger: { warn() {} } });
  feed.start();
  try {
    const ws = FakeWs.all[0];
    ws.emit('open');
    ws.emit('message', JSON.stringify({ event: 'data', channel: 'order_book_btcusd', data: { bids: [['1', '1']], asks: [['1.1', '1']] } }));
    assert.ok(feed.quotes.bitstamp);
    ws.emit('message', JSON.stringify({ event: 'bts:request_reconnect' }));
    assert.equal(ws.terminated, true);
    assert.equal(feed.quotes.bitstamp, undefined);
    assert.ok(feed.conn.bitstamp.timer, 'reconnect scheduled');
  } finally { feed.stop(); }
});

// ---- strike accuracy ----
function flat(price, from, to) { const h = []; for (let t = from; t < to; t += 1000) h.push({ price, timestamp: t }); return h; }

test('strike tracker measures each market once and reports both feeds', () => {
  const tr = new R.StrikeTracker();
  const markets = [];
  let reference = [], binance = [];
  for (let i = 0; i < 25; i++) {
    const open = 10_000_000 + i * 900_000;
    markets.push({ ticker: `M${i}`, openTime: open, floorStrike: 70000 });
    reference = reference.concat(flat(70003, open - 60000, open));
    binance = binance.concat(flat(70040, open - 60000, open));
  }
  const now = 10_000_000 + 25 * 900_000;
  tr.observe(markets, { reference, binance, now });
  tr.observe(markets, { reference, binance, now });
  const s = tr.summary();
  assert.equal(s.markets, 25);
  assert.ok(Math.abs(s.reference.meanAbsError - 3) < 1e-6);
  assert.ok(Math.abs(s.binance.meanAbsError - 40) < 1e-6);
  assert.ok(Math.abs(tr.referenceBias() - 3) < 1e-6);
  const early = new R.StrikeTracker();
  early.observe(markets.slice(0, 5), { reference, binance, now });
  assert.equal(early.referenceBias(), 0, 'no correction before 20 markets');
});

test('markets whose pre-open minute was not observed are skipped', () => {
  const tr = new R.StrikeTracker();
  tr.observe([{ ticker: 'X', openTime: 5_000_000, floorStrike: 70000 }], { reference: [], binance: flat(1, 4_940_000, 5_000_000), now: 5_010_000 });
  assert.equal(tr.summary().markets, 0);
});

// ---- probability against the official strike ----
function fakeFeed(price, history = [], healthy = true) {
  return { isHealthy: () => healthy, getPrice: () => price, priceHistory: history, getRecentVolatility: () => 0.0015 };
}

test('settlement probability uses floor_strike and the reference price', () => {
  const close = 2_000_000_000, open = close - 900_000, market = { openTime: open, closeTime: close, floorStrike: 70000 };
  const now = close - 300_000;
  const up = settlementProbabilityFromReference({ market, feed: fakeFeed(70300), now });
  const down = settlementProbabilityFromReference({ market, feed: fakeFeed(69700), now });
  const flatP = settlementProbabilityFromReference({ market, feed: fakeFeed(70000), now });
  assert.ok(up.probUp > 0.9 && down.probUp < 0.1, `${up.probUp} ${down.probUp}`);
  assert.ok(Math.abs(flatP.probUp - 0.5) < 1e-6);
  assert.equal(up.strikeSource, 'kalshi_floor_strike');
  const biased = settlementProbabilityFromReference({ market, feed: fakeFeed(70000), now, bias: 20 });
  assert.ok(biased.probUp < 0.5, 'positive feed bias lowers the corrected price');
});

test('final minute locks in the observed part of the average', () => {
  const close = 2_000_000_000, open = close - 900_000, market = { openTime: open, closeTime: close, floorStrike: 70000 };
  const now = close - 5000;
  const history = flat(70100, close - 60000, now);
  const p = settlementProbabilityFromReference({ market, feed: fakeFeed(69990, history), now });
  assert.ok(p.probUp >= 0.99, `55s of the average are already above the strike: ${p.probUp}`);
  assert.equal(p.observedSamples, 55);
});

test('fails safe without a healthy feed, a strike, or time left', () => {
  const close = 2_000_000_000, market = { openTime: close - 900_000, closeTime: close, floorStrike: 70000 };
  assert.equal(settlementProbabilityFromReference({ market, feed: fakeFeed(70000, [], false), now: close - 1000 }), null);
  assert.equal(settlementProbabilityFromReference({ market: { ...market, floorStrike: undefined }, feed: fakeFeed(70000), now: close - 1000 }), null);
  assert.equal(settlementProbabilityFromReference({ market, feed: fakeFeed(70000), now: close + 1 }), null);
  assert.equal(settlementProbabilityFromReference({ market, feed: null, now: close - 1000 }), null);
});

// ---- shadow evaluation: secondary only ----
test('shadow eval scores BRTI_PROXY on rows that have it without changing the status rule', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const y = i % 2;
    rows.push({ ticker: `T${i}`, ts: new Date(i * 1000).toISOString(), label: y, collector_meta: {
      collector_version: 'live-collector-v3.1', kalshi_yes_bid: 0.45, kalshi_yes_ask: 0.47, time_remaining_s: 200,
      gbm_p: 0.5, settlement_p: 0.5, ...(i < 30 ? { brti_p: y ? 0.8 : 0.2 } : {}),
    } });
  }
  const r = E.evaluate(rows);
  assert.equal(r.brtiProxy.markets, 30);
  assert.ok(r.brtiProxy.BRTI_PROXY.brier < r.brtiProxy.KALSHI_MID.brier);
  assert.ok(r.brtiProxy.brierDiff.BRTI_minus_KALSHI.high < 0);
  assert.equal(r.status, 'INSUFFICIENT_DATA');
  assert.deepEqual(E.MODELS, ['KALSHI_MID', 'GBM_POINT', 'SETTLEMENT']);
});

test('BRTI rows count even when the Binance-based models are missing', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const y = i % 2;
    rows.push({ ticker: `B${i}`, ts: new Date(i * 1000).toISOString(), label: y, collector_meta: {
      collector_version: 'live-collector-v3.1', kalshi_yes_bid: 0.45, kalshi_yes_ask: 0.47, time_remaining_s: 200,
      gbm_p: null, settlement_p: null, brti_p: y ? 0.9 : 0.1 } });
  }
  const r = E.evaluate(rows);
  assert.equal(r.markets, 0, 'primary comparison still requires GBM and SETTLEMENT');
  assert.equal(r.rejected.missing_model_p, 10);
  assert.equal(r.brtiProxy.markets, 10);
  assert.equal(r.brtiProxy.withGbm.markets, 0);
  assert.equal(r.brtiProxy.ready, false);
});
