'use strict';
// Pre-registered forward evaluation of the settlement-aware model (v3.1).
// Read-only. Compares, on the same settled v3.1 collector snapshots:
//   KALSHI_MID  = (yes_bid + yes_ask) / 2     (market benchmark)
//   GBM_POINT   = legacy model (gbm_p)
//   SETTLEMENT  = settlement-aware model (settlement_p)
// Primary metric: Brier (market-balanced, max 12 snapshots per market).
// Primary comparison: SETTLEMENT vs GBM_POINT, all regimes; secondary: vs KALSHI_MID.
// Frozen before any v3.1 data existed; do not tune thresholds against its output.
// v3.3 addition (secondary only, does not affect status): BRTI_PROXY = brti_p, the
// settlement model on Kalshi floor_strike + composite USD feed, scored on the rows that have it.
const { marketBalanced } = require('./baymax-residual');
const { bootstrap } = require('./final-precision-oos');

const MIN_MARKETS = 200;
const REGIMES = [['FINAL', 0, 120], ['LATE', 120, 300], ['MID', 300, 600], ['EARLY', 600, 901]];
const MODELS = ['KALSHI_MID', 'GBM_POINT', 'SETTLEMENT'];

const clip = p => Math.max(1e-6, Math.min(1 - 1e-6, p));
const brier = rows => rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;
const logLoss = rows => -rows.reduce((s, r) => s + (r.y ? Math.log(clip(r.p)) : Math.log(1 - clip(r.p))), 0) / rows.length;

function prepare(rows) {
  const out = [], rejected = {};
  const reject = why => { rejected[why] = (rejected[why] || 0) + 1; };
  for (const r of rows || []) {
    const m = r.collector_meta, y = Number(r.label);
    if (!m || m.collector_version !== 'live-collector-v3.1') { reject('not_v3_1'); continue; }
    if (r.label == null || ![0, 1].includes(y)) { reject('unsettled'); continue; }
    const bid = Number(m.kalshi_yes_bid), ask = Number(m.kalshi_yes_ask), t = Number(m.time_remaining_s);
    const gbm = Number(m.gbm_p), set = Number(m.settlement_p);
    if (!(bid > 0 && ask < 1 && ask >= bid)) { reject('invalid_quote'); continue; }
    if (!(gbm >= 0 && gbm <= 1) || !(set >= 0 && set <= 1) || m.gbm_p == null || m.settlement_p == null) { reject('missing_model_p'); continue; }
    if (!(t >= 0 && t <= 901)) { reject('invalid_time'); continue; }
    const p = { KALSHI_MID: (bid + ask) / 2, GBM_POINT: gbm, SETTLEMENT: set };
    const brti = Number(m.brti_p);
    if (m.brti_p != null && brti >= 0 && brti <= 1) p.BRTI_PROXY = brti;
    out.push({ ticker: r.ticker, ts: r.ts, y, t, basis: m.strike_basis, p });
  }
  return { rows: out, rejected };
}

function metricsFor(rows) {
  const res = { observations: rows.length, markets: new Set(rows.map(r => r.ticker)).size };
  if (!rows.length) return res;
  for (const m of MODELS) {
    const v = rows.map(r => ({ p: r.p[m], y: r.y }));
    res[m] = { brier: brier(v), logLoss: logLoss(v) };
  }
  const diff = (a, b) => bootstrap(rows, s => brier(s.map(r => ({ p: r.p[a], y: r.y }))) - brier(s.map(r => ({ p: r.p[b], y: r.y }))));
  res.brierDiff = { SETTLEMENT_minus_GBM: diff('SETTLEMENT', 'GBM_POINT'), SETTLEMENT_minus_KALSHI: diff('SETTLEMENT', 'KALSHI_MID') };
  return res;
}

function evaluate(rawRows) {
  const { rows, rejected } = prepare(rawRows);
  const balanced = marketBalanced(rows, 12);
  const markets = new Set(balanced.map(r => r.ticker)).size;
  const all = metricsFor(balanced);
  const regimes = Object.fromEntries(REGIMES.map(([n, lo, hi]) => [n, metricsFor(balanced.filter(r => r.t >= lo && r.t < hi))]));
  const basis = rows.map(r => Number(r.basis)).filter(Number.isFinite).sort((a, b) => a - b);
  const basisStats = basis.length ? { n: basis.length, median: basis[Math.floor(basis.length / 2)], p05: basis[Math.floor(.05 * (basis.length - 1))], p95: basis[Math.floor(.95 * (basis.length - 1))] } : null;
  let status = 'INSUFFICIENT_DATA';
  const ci = all.brierDiff?.SETTLEMENT_minus_GBM;
  if (markets >= MIN_MARKETS && ci) status = ci.high < 0 ? 'SETTLEMENT_BETTER_THAN_GBM' : ci.low > 0 ? 'SETTLEMENT_WORSE_THAN_GBM' : 'NO_SIGNIFICANT_DIFFERENCE';
  return { status, minMarkets: MIN_MARKETS, markets, rejected, all, regimes, strikeBasisUsd: basisStats, brtiProxy: brtiProxyMetrics(balanced) };
}

// Secondary (v3.3): BRTI_PROXY vs the other models on the subset of rows that carry brti_p.
function brtiProxyMetrics(rows) {
  const sub = rows.filter(r => r.p.BRTI_PROXY != null);
  const res = { observations: sub.length, markets: new Set(sub.map(r => r.ticker)).size };
  if (!sub.length) return res;
  for (const m of [...MODELS, 'BRTI_PROXY']) res[m] = { brier: brier(sub.map(r => ({ p: r.p[m], y: r.y }))) };
  const diff = b => bootstrap(sub, s => brier(s.map(r => ({ p: r.p.BRTI_PROXY, y: r.y }))) - brier(s.map(r => ({ p: r.p[b], y: r.y }))));
  res.brierDiff = { BRTI_minus_KALSHI: diff('KALSHI_MID'), BRTI_minus_GBM: diff('GBM_POINT') };
  return res;
}

module.exports = { MIN_MARKETS, REGIMES, MODELS, prepare, metricsFor, evaluate, brtiProxyMetrics };
