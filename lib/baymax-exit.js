'use strict';
// BAYMAX_EXIT_V1 — pre-registered hold-vs-sell test (spec: RESEARCH_LEDGER.md, 2026-11-13 02:30Z).
// Research only: reads data/exit-vs-hold.jsonl + collector snapshots, never trades.
//
// AMENDMENT (2026-11-13 ~06:30Z, written with the scripts, before any feature or outcome of
// any exit was joined or viewed): the distance feature uses floor_strike (Kalshi's official
// strike, present on 100% of v3.1 rows and the strike brti_p uses) instead of
// settlement_strike, which is null on ~92% of rows (Binance pre-open samples) and would
// exclude most exits. If cf_brti is null the composite reference_price is used. Nothing else
// in the spec changes.
//
// Until >= 600 eligible exits exist the script reports counts only (no outcomes), so the
// train/test rows stay unseen.
const { bootstrap } = require('./final-precision-oos');
const { estimateTakerFeeDollars } = require('./kalshi-economics');

const MIN_ELIGIBLE = 600, N_TRAIN = 400, N_TEST = 200, MAX_SNAPSHOT_AGE_MS = 15000;
const RULE_MARGIN = 0.03, L2_C = 1.0, BOOT_ITER = 10000, SEED = 20261113;
const FEATURE_NAMES = ['side_mid', 'side_brti_p', 'time_frac', 'side_bid', 'spread', 'side_dist_bps'];

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

// Latest snapshot at or before exitTime, no older than 15 s. snaps: [{ts, collector_meta}] sorted by ts.
function snapshotAt(snaps, exitTime) {
  let best = null;
  for (const s of snaps) {
    const t = Date.parse(s.ts);
    if (t <= exitTime && exitTime - t <= MAX_SNAPSHOT_AGE_MS && (!best || t > Date.parse(best.ts))) best = s;
  }
  return best;
}

// Side-adjusted feature vector, or null if any input is missing.
function features(exit, meta) {
  const yb = num(meta.kalshi_yes_bid), ya = num(meta.kalshi_yes_ask), p = num(meta.brti_p);
  const t = num(meta.time_remaining_s), k = num(meta.floor_strike);
  const px = Number.isFinite(num(meta.cf_brti)) ? num(meta.cf_brti) : num(meta.reference_price);
  if (![yb, ya, p, t, k, px].every(Number.isFinite) || k <= 0) return null;
  const yes = exit.side === 'yes';
  const mid = (yb + ya) / 2, dist = ((px - k) / k) * 1e4;
  return {
    side_mid: yes ? mid : 1 - mid,
    side_brti_p: yes ? p : 1 - p,
    time_frac: t / 900,
    side_bid: yes ? yb : 1 - ya,
    spread: ya - yb,
    side_dist_bps: yes ? dist : -dist,
  };
}

// L2 logistic regression via Newton/IRLS, sklearn convention: minimize 0.5*|w|^2 + C*sum(logloss);
// intercept unpenalized. X rows are already standardized.
function fitLogistic(X, y, C = L2_C, iters = 50) {
  const d = X[0].length + 1, w = new Array(d).fill(0);
  const row = x => [1, ...x];
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0), H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < X.length; i++) {
      const r = row(X[i]), z = r.reduce((s, v, j) => s + v * w[j], 0), p = 1 / (1 + Math.exp(-z)), q = p * (1 - p);
      for (let a = 0; a < d; a++) { g[a] += C * (p - y[i]) * r[a]; for (let b = 0; b < d; b++) H[a][b] += C * q * r[a] * r[b]; }
    }
    for (let a = 1; a < d; a++) { g[a] += w[a]; H[a][a] += 1; }
    const step = solve(H, g);
    let mx = 0;
    for (let a = 0; a < d; a++) { w[a] -= step[a]; mx = Math.max(mx, Math.abs(step[a])); }
    if (mx < 1e-9) break;
  }
  return { w, predict: x => 1 / (1 + Math.exp(-row(x).reduce((s, v, j) => s + v * w[j], 0))) };
}
function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

function standardizer(rows) {
  const m = FEATURE_NAMES.map(f => rows.reduce((s, r) => s + r.f[f], 0) / rows.length);
  const sd = FEATURE_NAMES.map((f, j) => Math.sqrt(rows.reduce((s, r) => s + (r.f[f] - m[j]) ** 2, 0) / rows.length) || 1);
  return r => FEATURE_NAMES.map((f, j) => (r.f[f] - m[j]) / sd[j]);
}

const exitFeePerContract = (bid, n) => estimateTakerFeeDollars(bid, n) / n;
const brier = (rows, pf) => rows.reduce((s, r) => s + (pf(r) - r.win) ** 2, 0) / rows.length;

// exits: exit-vs-hold rows; snapsByTicker: Map ticker -> sorted snapshots.
function buildRows(exits, snapsByTicker) {
  const rows = [], excluded = { noSnapshot: 0, missingFeature: 0, badRow: 0 };
  for (const e of [...exits].sort((a, b) => a.exitTime - b.exitTime)) {
    if (!e.ticker || !Number.isFinite(e.exitTime) || !Number.isFinite(e.pnl) || !Number.isFinite(e.holdPnl) || !['yes', 'no'].includes(e.side) || !['yes', 'no'].includes(e.result)) { excluded.badRow++; continue; }
    const s = snapshotAt(snapsByTicker.get(e.ticker) || [], e.exitTime);
    if (!s) { excluded.noSnapshot++; continue; }
    const f = features(e, s.collector_meta || {});
    if (!f) { excluded.missingFeature++; continue; }
    rows.push({ ticker: e.ticker, exitTime: e.exitTime, contracts: e.contracts, pnl: e.pnl, holdPnl: e.holdPnl, win: e.result === e.side ? 1 : 0, f });
  }
  return { rows, excluded, total: exits.length };
}

function evaluate(built) {
  const { rows } = built;
  const coverage = { totalExits: built.total, eligible: rows.length, excluded: built.excluded, needed: MIN_ELIGIBLE };
  if (rows.length < MIN_ELIGIBLE) return { status: 'INSUFFICIENT_DATA', coverage }; // counts only, no outcomes
  const train = rows.slice(0, N_TRAIN), test = rows.slice(N_TRAIN, N_TRAIN + N_TEST);
  const z = standardizer(train), model = fitLogistic(train.map(z), train.map(r => r.win));
  const holdRule = r => r.f.side_brti_p - r.f.side_bid >= RULE_MARGIN;
  const holdMl = r => model.predict(z(r)) - r.f.side_bid - exitFeePerContract(r.f.side_bid, r.contracts || 1) >= 0;
  const arms = {
    A_always_sell: () => false, B_always_hold: () => true, C_rule: holdRule, D_ml: holdMl,
  };
  const armPnl = (holdFn, r) => (holdFn(r) ? r.holdPnl : r.pnl);
  const tag = test.map(r => ({ ...r, A: r.pnl, B: r.holdPnl, C: armPnl(holdRule, r), D: armPnl(holdMl, r) }));
  const mean = (s, k) => s.reduce((a, r) => a + r[k], 0) / s.length;
  const ci = (a, b) => bootstrap(tag, s => mean(s, a) - mean(s, b), BOOT_ITER, SEED);
  const summary = {};
  for (const [name, fn] of Object.entries(arms)) {
    summary[name] = { pnl: test.reduce((s, r) => s + armPnl(fn, r), 0), holds: test.filter(fn).length };
  }
  const cCA = ci('C', 'A'), cDA = ci('D', 'A'), cDC = ci('D', 'C');
  const meanDC = mean(tag, 'D') - mean(tag, 'C');
  const cPass = cCA.low > 0, dPass = cDA.low > 0 && meanDC > 0;
  let status = 'NEITHER_PASSES';
  if (cPass && dPass) status = cDC.low > 0 ? 'ML_PASSES' : 'RULE_PASSES';
  else if (dPass) status = 'ML_PASSES';
  else if (cPass) status = 'RULE_PASSES';
  return {
    status, coverage,
    split: { train: train.length, test: test.length, trainEnds: new Date(train.at(-1).exitTime).toISOString(), testStarts: new Date(test[0].exitTime).toISOString() },
    arms: summary,
    ci: { C_minus_A: cCA, D_minus_A: cDA, D_minus_C: cDC }, meanDminusC: meanDC,
    model: { features: FEATURE_NAMES, weights: model.w },
    secondaryBrier: { kalshiMid: brier(test, r => r.f.side_mid), brtiP: brier(test, r => r.f.side_brti_p), ml: brier(test, r => model.predict(z(r))) },
  };
}

module.exports = { MIN_ELIGIBLE, N_TRAIN, N_TEST, FEATURE_NAMES, snapshotAt, features, fitLogistic, buildRows, evaluate };
