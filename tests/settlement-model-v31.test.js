const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/settlement-model');
const F = require('../lib/kalshi-format');
const supabase = require('../lib/supabase');
const MLDataCollector = require('../agents/skills/analysis/ml-data-collector');
const ProbabilityModel = require('../agents/skills/analysis/probability-model');
const E = require('../lib/settlement-shadow-eval');

function rng(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }

// Monte Carlo of the actual settlement rule: average of the last 60 one-second prices.
function simulate({ S0, K, t, sigma, observed = [], paths = 20000, seed = 7 }) {
  const r = rng(seed); let yes = 0;
  for (let i = 0; i < paths; i++) {
    let s = S0, sum = observed.reduce((a, b) => a + b, 0), n = observed.length;
    for (let k = 1; k <= t; k++) { s += sigma * S0 * gauss(r); if (k > t - (60 - observed.length)) { sum += s; n++; } }
    if (sum / n >= K) yes++;
  }
  return yes / paths;
}

test('V3.1 closed form matches Monte Carlo of 60s-average settlement (t >= 60s)', () => {
  const sigma = 0.00006, S0 = 80000, K = 80030, t = 90;
  const p = S.settlementProbability({ currentPrice: S0, strike: K, timeRemainingSec: t, sigmaPerSqrtSec: sigma }).probUp;
  const mc = simulate({ S0, K, t, sigma });
  assert.ok(Math.abs(p - mc) < 0.02, `closed=${p} mc=${mc}`);
});

test('V3.1 closed form matches Monte Carlo inside the final minute with locked-in average', () => {
  const sigma = 0.00006, S0 = 80000, K = 80000, t = 25;
  const observed = Array.from({ length: 35 }, () => 79980); // 35s already averaged below strike
  const obsAvg = 79980;
  const p = S.settlementProbability({ currentPrice: S0, strike: K, timeRemainingSec: t, sigmaPerSqrtSec: sigma, observedAvg: obsAvg }).probUp;
  const mc = simulate({ S0, K, t, sigma, observed });
  assert.ok(Math.abs(p - mc) < 0.02, `closed=${p} mc=${mc}`);
  assert.ok(p < 0.5, 'locked-in sub-strike average must pull P(YES) below 0.5 even with spot at strike');
});

test('V3.1 averaging reduces remaining uncertainty versus point GBM near close', () => {
  const sigma = 0.00006, S0 = 80040, K = 80000, t = 90;
  const settle = S.settlementProbability({ currentPrice: S0, strike: K, timeRemainingSec: t, sigmaPerSqrtSec: sigma }).probUp;
  const point = S.normalCdf((S0 - K) / (sigma * S0 * Math.sqrt(t)));
  assert.ok(settle > point, `settlement ${settle} should be more confident than point ${point}`);
});

test('V3.1 strike uses only the pre-open minute and requires coverage', () => {
  const open = 1_000_000;
  const hist = [];
  for (let i = -70; i < 10; i++) hist.push({ timestamp: open + i * 1000, price: i < -60 ? 1 : i < 0 ? 100 : 999 });
  const ref = S.referenceStrike(hist, open);
  assert.equal(ref.price, 100);
  assert.equal(ref.samples, 60);
  assert.equal(S.referenceStrike(hist.slice(-15), open), null);
});

test('V3.1 market wrapper fails safe without pre-open data and reports basis', () => {
  const open = 1_000_000, close = open + 900000, now = close - 200000;
  const hist = []; for (let i = -60; i < 0; i++) hist.push({ timestamp: open + i * 1000, price: 80010 });
  const feed = { priceHistory: hist, getRecentVolatility: () => 0.0018 };
  const r = S.settlementProbabilityForMarket({ market: { openTime: open, closeTime: close, floorStrike: 80000 }, currentPrice: 80010, now, feed });
  assert.equal(r.strike, 80010); assert.equal(r.basis, 10); assert.ok(Math.abs(r.probUp - 0.5) < 1e-9);
  assert.equal(S.settlementProbabilityForMarket({ market: { openTime: open, closeTime: close }, currentPrice: 1, now, feed: { priceHistory: [], getRecentVolatility: () => 0.002 } }), null);
  assert.ok(new ProbabilityModel().calculateSettlementProbability({ openTime: open, closeTime: close }, 80010, feed, now));
});

test('V3.1 parseMarket preserves Kalshi floor_strike', () => {
  assert.equal(F.parseMarket({ ticker: 'X', floor_strike: 82513.98 }).floorStrike, 82513.98);
  assert.equal(F.parseMarket({ ticker: 'X' }).floorStrike, undefined);
});

test('V3.1 collector uses live per-market volatility/trend instead of frozen state.model', async () => {
  const rows = []; const oldEnabled = supabase.enabled, oldLog = supabase.logFeatures;
  supabase.enabled = true; supabase.logFeatures = async row => rows.push(row);
  try {
    const now = Date.now(), open = now - 800000, close = open + 900000;
    const hist = []; for (let i = -60; i < 0; i++) hist.push({ timestamp: open + i * 1000, price: 100000 });
    const feed = { priceHistory: hist, getRecentVolatility: () => 0.0042 };
    const state = {
      activeMarkets: [{ ticker: 'T', openTime: open, closeTime: close, yesAsk: .55, noAsk: .46, yesBid: .54, noBid: .45, floorStrike: 99990 }],
      btcPrice: { binance: 100050 }, marketOpenPrices: { T: 100000 },
      model: { impliedProbUp: .9, volatility: .001, trend: 'BEARISH', trendStrength: .1, trendROC: -1 },
      stats: {}, balance: {},
    };
    const skills = {
      'state-manager': { botState: state },
      'binance-price-feed': { getFeed: () => feed },
      'trend-analysis': { getIndicator: () => ({ getTrend: () => ({ trend: 'BULLISH', strength: .8, roc: .3 }) }) },
      'probability-model': new ProbabilityModel(),
    };
    const c = new MLDataCollector(); c.context = { registry: { get: n => skills[n] || null } };
    await c._collect();
    const v = rows[0].vector;
    assert.equal(v[5], 0.0042 * 1000);          // live volatility, not stale .001
    assert.equal(v[21], .8); assert.equal(v[22], .3); // live trend
    assert.notEqual(v[8], .9);                   // model_prob recomputed for this market
    assert.equal(rows[0].collectorMeta.collector_version, 'live-collector-v3.1');
    assert.equal(rows[0].collectorMeta.floor_strike, 99990);
    assert.ok(rows[0].collectorMeta.settlement_p > 0.5);
  } finally { supabase.enabled = oldEnabled; supabase.logFeatures = oldLog; }
});

test('V3.1 logFeatures retries without collector_meta when the column is missing', async () => {
  const oldEnabled = supabase.enabled, oldClient = supabase.client, oldFlag = supabase.collectorMetaUnsupported;
  const sent = [];
  supabase.enabled = true; supabase.collectorMetaUnsupported = false;
  supabase.client = { from: () => ({ upsert: async rec => { sent.push({ ...rec }); return { error: rec.collector_meta ? { message: "Could not find the 'collector_meta' column" } : null }; } }) };
  const oldWarn = console.warn; console.warn = () => {};
  try {
    await supabase.logFeatures({ observationId: 'a', ticker: 'T', vector: [1], collectorMeta: { x: 1 } });
    await supabase.logFeatures({ observationId: 'b', ticker: 'T', vector: [1], collectorMeta: { x: 1 } });
    assert.equal(sent.length, 3);
    assert.ok(sent[0].collector_meta && !sent[1].collector_meta && !sent[2].collector_meta);
  } finally { console.warn = oldWarn; supabase.enabled = oldEnabled; supabase.client = oldClient; supabase.collectorMetaUnsupported = oldFlag; }
});

test('V3.1 shadow evaluator: insufficient data, then detects a better model', () => {
  assert.equal(E.evaluate([]).status, 'INSUFFICIENT_DATA');
  const r = rng(3), rows = [];
  for (let m = 0; m < 260; m++) {
    const y = r() < 0.5 ? 1 : 0;
    for (let k = 0; k < 4; k++) rows.push({ ticker: `M${m}`, ts: new Date(m * 1e6 + k).toISOString(), label: y,
      collector_meta: { collector_version: 'live-collector-v3.1', kalshi_yes_bid: .49, kalshi_yes_ask: .51, time_remaining_s: 30 + k * 200, gbm_p: .5, settlement_p: y ? .8 : .2, strike_basis: 5 } });
  }
  const out = E.evaluate(rows);
  assert.equal(out.markets, 260);
  assert.equal(out.status, 'SETTLEMENT_BETTER_THAN_GBM');
  assert.ok(out.regimes.FINAL.markets > 0);
});

test('V3.1 REGRESSION: normal CDF is correct and continuous at 0 in every model path', () => {
  const { normalCdf } = require('../lib/normal');
  const known = [[-2, 0.0227501], [-1, 0.1586553], [0, 0.5], [0.5, 0.6914625], [1.96, 0.9750021]];
  for (const [x, v] of known) assert.ok(Math.abs(normalCdf(x) - v) < 1e-6, `Phi(${x})`);
  for (const x of [0.1, 0.7, 2.3]) assert.ok(Math.abs(normalCdf(x) + normalCdf(-x) - 1) < 1e-9);
  const pm = new ProbabilityModel();
  assert.ok(Math.abs(pm.normalCDF(1e-9) - pm.normalCDF(-1e-9)) < 1e-6, 'no jump at 0');
  // Price at the strike must be a coin flip, not 80/20.
  const feed = { getRecentVolatility: () => 0.0015 };
  const p = pm.calculateImpliedProbability(80000.01, 80000, 300000, 900000, feed);
  assert.ok(Math.abs(p.probUp - 0.5) < 0.01, `probUp=${p.probUp}`);
});
