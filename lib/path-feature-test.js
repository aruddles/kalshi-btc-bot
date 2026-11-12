'use strict';
// Pre-registered path-feature test (frozen 2026-11-12 before any result was seen).
// Question: does the recent PATH of BTC and of Kalshi's price add predictive power
// beyond the 14 market-only features? (Cheap prerequisite before any RNN/GRU.)
// Data: data/historical-ml-v4-5000-markets.jsonl (Grade B, 120s spacing).
// Path features, computed only from EARLIER snapshots of the same market:
//   btc move over last 120s and 240s (per mille), Kalshi YES mid change over 120s
//   and 240s, and a has-history flag.
// Split: markets in time order, oldest 70% train, newest 30% test (whole markets).
// Model: the existing gradient-boosted stumps (ml-pipeline._fitStumpModel), same
// settings for BASELINE (14 features) and PATH (14 + 5). No tuning.
// Primary metric: test Brier, PATH minus BASELINE, market-clustered bootstrap 95% CI
// (1000 draws, seed 20261112). CI entirely < 0 -> PATH_HELPS; CI entirely > 0 ->
// PATH_HURTS; else NO_EVIDENCE. Kalshi-mid Brier reported for context only.
const { MARKET_ONLY_FEATURE_INDEXES } = require('./ml-feature-schema');
const { bootstrap } = require('./final-precision-oos');

const LAGS = [120, 240];

function mid(r) { const b = Number(r.metadata?.kalshi_yes_bid), a = Number(r.metadata?.kalshi_yes_ask); return b > 0 && a < 1 && a >= b ? (a + b) / 2 : null; }

function build(rows) {
  const byMarket = new Map();
  for (const r of rows || []) {
    const y = Number(r.label), t = Number(r.metadata?.time_remaining_s), btc = Number(r.metadata?.btc_price), m = mid(r);
    if (!r.ticker || ![0, 1].includes(y) || !Number.isFinite(t) || !(btc > 0) || m == null || !Array.isArray(r.features)) continue;
    const base = MARKET_ONLY_FEATURE_INDEXES.map(i => Number(r.features[i]));
    if (!base.every(Number.isFinite)) continue;
    if (!byMarket.has(r.ticker)) byMarket.set(r.ticker, []);
    byMarket.get(r.ticker).push({ ticker: r.ticker, ts: r.ts, t, btc, mid: m, label: y, base });
  }
  const out = [];
  for (const list of byMarket.values()) {
    list.sort((a, b) => b.t - a.t); // most time remaining first = chronological
    for (let i = 0; i < list.length; i++) {
      const cur = list[i], path = [];
      let has = 1;
      for (const lag of LAGS) {
        const prev = list.slice(0, i).reverse().find(p => p.t - cur.t >= lag - 1);
        if (!prev) has = 0;
        path.push(prev ? (cur.btc - prev.btc) / prev.btc * 1000 : 0, prev ? (cur.mid - prev.mid) * 100 : 0);
      }
      out.push({ ...cur, path: [...path, has] });
    }
  }
  return out;
}

function split(rows, trainFrac = 0.7) {
  const first = new Map();
  for (const r of rows) { const ts = Date.parse(r.ts); if (!first.has(r.ticker) || ts < first.get(r.ticker)) first.set(r.ticker, ts); }
  const order = [...first].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(x => x[0]);
  const cut = Math.floor(order.length * trainFrac), train = new Set(order.slice(0, cut));
  return { train: rows.filter(r => train.has(r.ticker)), test: rows.filter(r => !train.has(r.ticker)), trainMarkets: cut, testMarkets: order.length - cut };
}

const brier = (rows, key) => rows.reduce((s, r) => s + (r[key] - r.label) ** 2, 0) / rows.length;

function run(rawRows, pipeline) {
  const rows = build(rawRows);
  const s = split(rows);
  if (s.trainMarkets < 100 || s.testMarkets < 100) return { status: 'INSUFFICIENT_DATA', markets: s.trainMarkets + s.testMarkets };
  const fit = feats => pipeline._fitStumpModel(s.train.map(r => ({ features: feats(r), label: r.label })));
  const fb = r => r.base, fp = r => [...r.base, ...r.path];
  const mb = fit(fb), mp = fit(fp);
  const test = s.test.map(r => ({ ticker: r.ticker, label: r.label, t: r.t, kalshi: r.mid,
    base: pipeline._predictStumpModel(mb, fb(r)), path: pipeline._predictStumpModel(mp, fp(r)) }));
  const ci = bootstrap(test, a => brier(a, 'path') - brier(a, 'base'), 1000, 20261112);
  const status = !ci ? 'INSUFFICIENT_DATA' : ci.high < 0 ? 'PATH_HELPS' : ci.low > 0 ? 'PATH_HURTS' : 'NO_EVIDENCE';
  const regime = (lo, hi) => { const x = test.filter(r => r.t >= lo && r.t < hi); return x.length ? { n: x.length, base: brier(x, 'base'), path: brier(x, 'path'), kalshi: brier(x, 'kalshi') } : null; };
  return {
    status, trainMarkets: s.trainMarkets, testMarkets: s.testMarkets, testObservations: test.length,
    brier: { kalshiMid: brier(test, 'kalshi'), baseline: brier(test, 'base'), path: brier(test, 'path') },
    pathMinusBaselineCI: ci,
    regimes: { FINAL: regime(0, 120), LATE: regime(120, 300), MID: regime(300, 600), EARLY: regime(600, 901) },
  };
}

module.exports = { LAGS, build, split, run };
