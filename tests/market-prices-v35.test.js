'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/market-prices');
const SignalGenerator = require('../agents/skills/analysis/signal-generator');
const ProbabilityModel = require('../agents/skills/analysis/probability-model');

const OPEN = 1_800_000_000_000;
const market = { ticker: 'KXBTC15M-T', openTime: OPEN, closeTime: OPEN + 900_000 };
const feedAt = (price, ts = OPEN + 400) => ({ getPriceAt: (t, tol) => (Math.abs(ts - t) <= tol ? { price, timestamp: ts } : null) });

test('opening price prefers the composite feed, falls back to Binance, never fakes a missed open', () => {
  const s1 = {};
  assert.equal(P.recordOpenPrice(s1, market, { reference: feedAt(70000), binance: feedAt(70060) }), 'usd_reference_at_market_open');
  assert.equal(s1.marketOpenPrices[market.ticker], 70000);

  const s2 = {};
  assert.equal(P.recordOpenPrice(s2, market, { reference: feedAt(70000, OPEN + 9000), binance: feedAt(70060) }), 'binance_at_market_open');
  assert.equal(s2.marketOpenPrices[market.ticker], 70060);

  const s3 = {};
  assert.equal(P.recordOpenPrice(s3, market, { reference: null, binance: feedAt(70060, OPEN + 26000) }), null, 'a 26s-late Binance tick is not an opening price');
  assert.deepEqual(s3.marketOpenPrices, {});

  // Once recorded, later calls keep the original.
  assert.equal(P.recordOpenPrice(s1, market, { reference: feedAt(71000), binance: null }), 'usd_reference_at_market_open');
  assert.equal(s1.marketOpenPrices[market.ticker], 70000);
});

test('current price always comes from the feed that recorded the open', () => {
  const reference = { isHealthy: () => true, getPrice: () => 70100 };
  const binance = {};
  const state = { btcPrice: { binance: 70180 } };
  P.recordOpenPrice(state, market, { reference: feedAt(70000), binance: feedAt(70060) });
  const a = P.marketPriceInputs(market, state, { reference, binance });
  assert.deepEqual([a.openPrice, a.currentPrice, a.source], [70000, 70100, 'usd_reference_at_market_open']);
  assert.equal(P.marketPriceInputs(market, state, { reference: { isHealthy: () => false, getPrice: () => 70100 }, binance }), null,
    'an unhealthy composite feed is not replaced by a Binance price in different units');

  const s2 = { btcPrice: { binance: 70180 } };
  P.recordOpenPrice(s2, market, { reference: null, binance: feedAt(70060) });
  const b = P.marketPriceInputs(market, s2, { reference, binance });
  assert.deepEqual([b.openPrice, b.currentPrice, b.source], [70060, 70180, 'binance_at_market_open']);
  assert.equal(P.marketPriceInputs(market, { ...s2, btcPrice: {} }, { reference, binance }), null);
});

// ---- signal generator end to end with a composite-feed open and no Binance price ----
function harness({ refHealthy = true } = {}) {
  const now = Date.now();
  const m = { ticker: 'KXBTC15M-LIVE', openTime: now - 60_000, closeTime: now + 840_000, yesAsk: 0.6, noAsk: 0.42, yesAskCents: 60, noAskCents: 42, feeMultiplier: 1 };
  const reference = { isHealthy: () => refHealthy, getPrice: () => 70300, getRecentVolatility: () => 0.001, priceHistory: [], getPriceAt: () => null };
  const model = {};
  const state = {
    btcPrice: {}, balance: { available: 100 }, activeMarkets: [m],
    marketOpenPrices: { [m.ticker]: 70000 },
    marketOpenPriceMeta: { [m.ticker]: { source: 'usd_reference_at_market_open', timestamp: m.openTime + 300 } },
    updateModel: x => Object.assign(model, x), updateIntent() {},
  };
  const skills = {
    'state-manager': { botState: state },
    'usd-reference-feed': { getFeed: () => reference, getBias: () => 0 },
    'binance-price-feed': { getFeed: () => ({ getRecentVolatility: () => 0.001, priceHistory: [] }) },
    'trend-analysis': { getIndicator: () => null, getTrendMultiplier: () => 1 },
    'polymarket-price-feed': { getCachedPrice: () => null },
  };
  const registry = { get: n => skills[n] || null };
  const pm = new ProbabilityModel(); pm.context = { registry, config: {} }; skills['probability-model'] = pm;
  const sg = new SignalGenerator(); sg.context = { registry, config: { KALSHI_TAKER_FEE_RATE: 0.07 } };
  return { sg, state, model, m };
}

test('markets are priced from the composite feed even when Binance has no price', () => {
  const { sg, state, model, m } = harness();
  const signals = sg._generateSignals([m], state);
  assert.equal(model.openPriceSource, 'usd_reference_at_market_open');
  assert.equal(model.targetPrice, 70000);
  assert.ok(model.gbmProbUp > 0.9, `+$300 with low vol should be a strong UP: ${model.gbmProbUp}`);
  assert.ok(signals.some(s => s.type === 'DIRECTIONAL_YES'), 'a YES signal is produced from composite prices');
});

test('a market opened on the composite feed is skipped when that feed is unhealthy', () => {
  const { sg, state, model, m } = harness({ refHealthy: false });
  state.btcPrice.binance = 70380;
  assert.equal(sg._generateSignals([m], state).length, 0);
  assert.equal(model.openPriceSource, undefined, 'no model update from mixed-feed prices');
});
