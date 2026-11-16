'use strict';
// BAYMAX_ENTRY_V1 — a "judge" model for the main bot's own entries (meta-labeling).
// PRE-REGISTERED 2026-11-16 (spec in RESEARCH_LEDGER.md), before any feature-vs-outcome
// relation in the training trades was examined. Read-only research: it labels trades
// after the fact from data/trades.jsonl and never changes what the bot does.
//
//   Train:  every logged trade with entryTime < REGISTERED_AT (frozen; the log is append-only).
//   Test:   trades with entryTime >= REGISTERED_AT only (forward, unseen at registration).
//   Inputs: known at entry — the trade's own fields plus trades already closed by then.
//   Model:  ridge regression (lambda = 1, standardized inputs, no tuning) predicting
//           the trade's return, pnl / cost.
//   Label:  SKIP if predicted return < the 25th percentile of the training predictions
//           (a number fixed by the training data), else TAKE.
//   Metric: mean return of SKIP trades minus mean return of TAKE trades on the test set,
//           market-clustered bootstrap 95% CI (10,000, fixed seed).
//   Verdict only with >= 300 test trades, >= 50 SKIP trades and >= 40 test markets:
//     CI < 0 -> JUDGE_WORKS (skipped trades really are worse); CI > 0 -> JUDGE_BACKWARDS;
//     else NO_EVIDENCE. Before the threshold only counts are reported.
const crypto = require('crypto');
const { bootstrap } = require('./final-precision-oos');
const { solve } = require('./baymax-exit');
const { trendLabel, isCounterTrend } = require('./trend-filter');

const REGISTERED_AT = Date.parse('2026-11-16T11:00:00Z');
const MIN_TEST = 300, MIN_SKIP = 50, MIN_MARKETS = 40, ITER = 10000, SEED = 20261116;
const LAMBDA = 1, SKIP_QUANTILE = 0.25;
const FEATURE_NAMES = ['price', 'edge', 'model_prob', 'time_left', 'side_yes', 'trend_align', 'recent_win20', 'same_side_pnl10', 'stack_index'];

const cost = t => t.cost ?? t.totalCost;
const closedAt = t => t.settleTime ?? t.closeTime;

// One row per usable trade, in entry order, with features that use only information
// available at that trade's entry.
function buildRows(trades) {
  const seen = new Set(), ok = [];
  let excluded = 0;
  for (const t of trades) {
    const good = t && t.orderId && !seen.has(t.orderId) && t.ticker && Number.isFinite(t.entryTime) && Number.isFinite(t.closeTime) &&
      Number.isFinite(t.pnl) && cost(t) > 0 && Number.isFinite(t.priceDecimal) && Number.isFinite(t.edge) && Number.isFinite(t.modelProb) &&
      (t.side === 'yes' || t.side === 'no');
    if (!good) { excluded++; continue; }
    seen.add(t.orderId); ok.push(t);
  }
  ok.sort((a, b) => a.entryTime - b.entryTime);
  const byClose = [...ok].sort((a, b) => closedAt(a) - closedAt(b));
  const rows = [];
  let k = 0; const closed = [];               // trades closed at or before the current entry
  const stack = new Map();
  for (const t of ok) {
    while (k < byClose.length && closedAt(byClose[k]) <= t.entryTime) closed.push(byClose[k++]);
    const last20 = closed.slice(-20), sameSide = closed.filter(c => c.side === t.side).slice(-10);
    const label = trendLabel(t.reason);
    const f = {
      price: t.priceDecimal,
      edge: t.edge,
      model_prob: t.modelProb,
      time_left: Math.max(0, Math.min(1, (t.closeTime - t.entryTime) / 900000)),
      side_yes: t.side === 'yes' ? 1 : 0,
      trend_align: !label || label === 'NEUTRAL' ? 0 : (isCounterTrend(t) ? -1 : 1),
      recent_win20: last20.length >= 5 ? last20.filter(c => c.pnl > 0).length / last20.length : 0.8,
      same_side_pnl10: sameSide.reduce((s, c) => s + c.pnl, 0),
      stack_index: stack.get(t.ticker) || 0,
    };
    stack.set(t.ticker, (stack.get(t.ticker) || 0) + 1);
    rows.push({ orderId: t.orderId, ticker: t.ticker, entryTime: t.entryTime, pnl: t.pnl, r: t.pnl / cost(t), f });
  }
  return { rows, excluded };
}

// Ridge regression with an unpenalized intercept on standardized features.
function fit(train) {
  const n = train.length, d = FEATURE_NAMES.length;
  const mean = FEATURE_NAMES.map(f => train.reduce((s, r) => s + r.f[f], 0) / n);
  const sd = FEATURE_NAMES.map((f, j) => Math.sqrt(train.reduce((s, r) => s + (r.f[f] - mean[j]) ** 2, 0) / n) || 1);
  const z = r => [1, ...FEATURE_NAMES.map((f, j) => (r.f[f] - mean[j]) / sd[j])];
  const A = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0)), b = new Array(d + 1).fill(0);
  for (const r of train) { const x = z(r); for (let i = 0; i <= d; i++) { b[i] += x[i] * r.r; for (let j = 0; j <= d; j++) A[i][j] += x[i] * x[j]; } }
  for (let i = 1; i <= d; i++) A[i][i] += LAMBDA;
  const w = solve(A, b);
  const predict = r => z(r).reduce((s, v, j) => s + v * w[j], 0);
  const preds = train.map(predict).sort((a, c) => a - c);
  const threshold = preds[Math.floor(SKIP_QUANTILE * (preds.length - 1))];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ n, w: w.map(v => +v.toFixed(10)), mean: mean.map(v => +v.toFixed(10)), sd: sd.map(v => +v.toFixed(10)), threshold: +threshold.toFixed(10) })).digest('hex').slice(0, 16);
  return { w, mean, sd, threshold, predict, fingerprint, weights: Object.fromEntries(FEATURE_NAMES.map((f, j) => [f, w[j + 1]])) };
}

function evaluate(trades, { registeredAt = REGISTERED_AT, minTrain = 200 } = {}) {
  const { rows, excluded } = buildRows(trades);
  const train = rows.filter(r => r.entryTime < registeredAt), test = rows.filter(r => r.entryTime >= registeredAt);
  if (train.length < minTrain) return { status: 'INSUFFICIENT_TRAINING_DATA', counts: { train: train.length, excluded } };
  const model = fit(train);
  for (const r of test) { r.pred = model.predict(r); r.skip = r.pred < model.threshold; }
  const skip = test.filter(r => r.skip), take = test.filter(r => !r.skip);
  const counts = { train: train.length, trainMarkets: new Set(train.map(r => r.ticker)).size, test: test.length, testMarkets: new Set(test.map(r => r.ticker)).size,
    skip: skip.length, take: take.length, excluded, needed: { MIN_TEST, MIN_SKIP, MIN_MARKETS } };
  const base = { counts, fingerprint: model.fingerprint, threshold: model.threshold, weights: model.weights };
  if (test.length < MIN_TEST || skip.length < MIN_SKIP || counts.testMarkets < MIN_MARKETS) return { status: 'INSUFFICIENT_DATA', ...base };
  const mean = a => a.reduce((s, r) => s + r.r, 0) / a.length, sum = a => a.reduce((s, r) => s + r.pnl, 0);
  const ci = bootstrap(test, a => { const s = a.filter(r => r.skip), t = a.filter(r => !r.skip); return s.length && t.length ? mean(s) - mean(t) : null; }, ITER, SEED);
  const status = !ci ? 'NO_EVIDENCE' : ci.high < 0 ? 'JUDGE_WORKS' : ci.low > 0 ? 'JUDGE_BACKWARDS' : 'NO_EVIDENCE';
  const win = a => a.filter(r => r.pnl > 0).length / a.length;
  return { status, ...base, ci, skipMeanReturn: mean(skip), takeMeanReturn: mean(take), diff: mean(skip) - mean(take),
    skipWinRate: win(skip), takeWinRate: win(take), pnlAll: sum(test), pnlTakeOnly: sum(take), pnlSkipped: sum(skip) };
}

module.exports = { REGISTERED_AT, MIN_TEST, MIN_SKIP, MIN_MARKETS, FEATURE_NAMES, buildRows, fit, evaluate };
