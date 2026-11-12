'use strict';
// Pre-registered "Kalshi error" test (frozen 2026-11-12, before any result was seen).
// Question: does the recent path predict where Kalshi's price is WRONG?
// Data/split/path features: identical to lib/path-feature-test.js (historical v4,
// oldest 70% of markets train, newest 30% test). Note: this test split was already
// used once (path-feature test); this is a second, different hypothesis on it, so a
// positive result here is discovery and must be confirmed on live forward data.
// Arms (logistic regression, standardized inputs, fixed settings, no tuning):
//   KALSHI_RECAL: P(YES) = sigmoid(a + b*logit(kalshi_mid))
//   KALSHI_PATH:  same + the 5 path features
// Primary: test Brier, KALSHI_PATH minus KALSHI_RECAL, market-clustered bootstrap 95% CI
// (1000 draws, seed 20261112). CI < 0 -> PATH_PREDICTS_KALSHI_ERROR; CI > 0 -> PATH_HURTS;
// else NO_EVIDENCE.
// Secondary (descriptive, not a decision): hypothetical hold-to-settlement trades on
// test, one per market at the first snapshot where the model's after-fee edge vs the
// executable ask is >= 3c (YES ask; NO ask = 1 - YES bid).
const { build, split } = require('./path-feature-test');
const { bootstrap } = require('./final-precision-oos');
const { estimateTakerFeeDollars } = require('./kalshi-economics');

const clip = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = p => Math.log(clip(p) / (1 - clip(p)));
const sigmoid = z => 1 / (1 + Math.exp(-z));

function fitLogistic(X, y, { iters = 2000, lr = 0.1, l2 = 1e-4 } = {}) {
  const d = X[0].length, n = X.length;
  const mean = Array(d).fill(0), sd = Array(d).fill(0);
  for (const x of X) x.forEach((v, j) => { mean[j] += v / n; });
  for (const x of X) x.forEach((v, j) => { sd[j] += (v - mean[j]) ** 2 / n; });
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map(x => x.map((v, j) => (v - mean[j]) / sd[j]));
  let w = Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { const z = Z[i]; let s = b; for (let j = 0; j < d; j++) s += w[j] * z[j]; const e = sigmoid(s) - y[i]; gb += e; for (let j = 0; j < d; j++) gw[j] += e * z[j]; }
    b -= lr * gb / n; for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { predict: x => { let s = b; for (let j = 0; j < d; j++) s += w[j] * (x[j] - mean[j]) / sd[j]; return sigmoid(s); }, w, b, mean, sd };
}

const brier = (rows, key) => rows.reduce((s, r) => s + (r[key] - r.label) ** 2, 0) / rows.length;

function simulateTrades(test, key, minEdge = 0.03) {
  const byMarket = new Map();
  for (const r of test) { if (!byMarket.has(r.ticker)) byMarket.set(r.ticker, []); byMarket.get(r.ticker).push(r); }
  const trades = [];
  for (const rows of byMarket.values()) {
    rows.sort((a, b) => b.t - a.t);
    for (const r of rows) {
      const p = r[key], opts = [['yes', p, r.ask], ['no', 1 - p, 1 - r.bid]]
        .filter(([, , px]) => px > 0 && px < 1)
        .map(([side, prob, px]) => ({ side, px, edge: prob - px - estimateTakerFeeDollars(px, 1) }))
        .sort((a, b) => b.edge - a.edge);
      const o = opts[0];
      if (!o || o.edge < minEdge) continue;
      const won = (o.side === 'yes') === (r.label === 1), fee = estimateTakerFeeDollars(o.px, 1);
      trades.push({ ticker: r.ticker, t: r.t, side: o.side, px: o.px, edge: o.edge, pnl: (won ? 1 : 0) - o.px - fee });
      break;
    }
  }
  const pnl = trades.reduce((s, x) => s + x.pnl, 0);
  return { trades: trades.length, totalPnl: pnl, evPerTrade: trades.length ? pnl / trades.length : null,
    ci: trades.length >= 5 ? bootstrap(trades, a => a.reduce((s, x) => s + x.pnl, 0) / a.length, 1000, 20261112) : null };
}

function run(rawRows) {
  const meta = new Map(rawRows.map(r => [r.ticker + '|' + r.ts, r.metadata]));
  const rows = build(rawRows).map(r => { const m = meta.get(r.ticker + '|' + r.ts) || {}; return { ...r, bid: Number(m.kalshi_yes_bid), ask: Number(m.kalshi_yes_ask) }; });
  const s = split(rows);
  if (s.trainMarkets < 100 || s.testMarkets < 100) return { status: 'INSUFFICIENT_DATA' };
  const xr = r => [logit(r.mid)], xp = r => [logit(r.mid), ...r.path];
  const y = s.train.map(r => r.label);
  const mr = fitLogistic(s.train.map(xr), y), mp = fitLogistic(s.train.map(xp), y);
  const test = s.test.map(r => ({ ticker: r.ticker, t: r.t, label: r.label, bid: r.bid, ask: r.ask, kalshi: r.mid, recal: mr.predict(xr(r)), path: mp.predict(xp(r)) }));
  const ci = bootstrap(test, a => brier(a, 'path') - brier(a, 'recal'), 1000, 20261112);
  const status = !ci ? 'INSUFFICIENT_DATA' : ci.high < 0 ? 'PATH_PREDICTS_KALSHI_ERROR' : ci.low > 0 ? 'PATH_HURTS' : 'NO_EVIDENCE';
  const regime = (lo, hi) => { const x = test.filter(r => r.t >= lo && r.t < hi); return x.length ? { n: x.length, kalshi: brier(x, 'kalshi'), recal: brier(x, 'recal'), path: brier(x, 'path') } : null; };
  return {
    status, trainMarkets: s.trainMarkets, testMarkets: s.testMarkets, testObservations: test.length,
    brier: { kalshiMid: brier(test, 'kalshi'), kalshiRecal: brier(test, 'recal'), kalshiPath: brier(test, 'path') },
    pathMinusRecalCI: ci,
    regimes: { FINAL: regime(0, 120), LATE: regime(120, 300), MID: regime(300, 600), EARLY: regime(600, 901) },
    pathWeights: { names: ['logit_kalshi', 'btc_120', 'kalshi_120', 'btc_240', 'kalshi_240', 'has_history'], w: mp.w },
    secondaryTrades: { recal: simulateTrades(test, 'recal'), path: simulateTrades(test, 'path') },
  };
}

module.exports = { fitLogistic, simulateTrades, run };
