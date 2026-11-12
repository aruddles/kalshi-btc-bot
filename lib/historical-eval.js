'use strict';
// Shared helpers for scoring and retraining models on the historical dataset
// (scripts/score-historical.js, scripts/retrain-historical.js). Read-only.

const fs = require('fs');
const { normalCdf } = require('./normal');
const { MARKET_ONLY_FEATURE_INDEXES } = require('./ml-feature-schema');
const { estimateTakerFeeDollars } = require('./kalshi-economics');

const clip = p => Math.min(0.99, Math.max(0.01, p));
const logit = p => { const q = clip(p); return Math.log(q / (1 - q)); };
const sigmoid = z => 1 / (1 + Math.exp(-z));

// Rows sorted by time. Refuses historical-builder-v1 rows (lookahead leak) unless allowLeaky.
function loadRows(file, { allowLeaky = false } = {}) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const leaky = rows.filter(r => r.collector_version === 'historical-builder-v1').length;
  if (leaky && !allowLeaky) {
    throw new Error(`${leaky} row(s) come from historical-builder-v1 (lookahead leak). Rebuild with npm run historical:ml, or pass --allow-leaky.`);
  }
  return rows.filter(r => r.metadata && r.metadata.btc_price > 0 && r.metadata.target_price > 0 && (r.label === 0 || r.label === 1))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function kalshiMid(r) {
  const b = Number(r.metadata.kalshi_yes_bid), a = Number(r.metadata.kalshi_yes_ask);
  return b > 0 && a > 0 && a < 1 && b < 1 && a >= b ? (a + b) / 2 : null;
}

// GBM on the reconstructed snapshot. features[5] is per-minute log-return vol x 1000.
function gbm(r, sigmaPerMin) {
  const sd = sigmaPerMin * Math.sqrt(r.metadata.time_remaining_s / 60);
  return clip(normalCdf(Math.log(r.metadata.btc_price / r.metadata.target_price) / sd));
}

function medianVolPerMinute(rows) {
  const vols = rows.map(r => r.features[5] / 1000).filter(v => v > 0).sort((a, b) => a - b);
  return vols[vols.length >> 1] || 0.00025;
}

// GBM with the v3.2 vol shrinkage toward `medianVol` (estimated on training rows only).
function gbmShrunk(r, medianVol) {
  const raw = r.features[5] > 0 ? r.features[5] / 1000 : medianVol;
  return gbm(r, Math.sqrt(0.5 * raw ** 2 + 0.5 * medianVol ** 2));
}

const projectMarketOnly = features => MARKET_ONLY_FEATURE_INDEXES.map(i => Number(features[i]));

// Chronological market split. fractions = [train, calibration, test] summing to 1;
// markets are ordered by their first snapshot.
function chronologicalSplit(rows, fractions = [0.5, 0.1, 0.4]) {
  const tickers = [...new Set(rows.map(r => r.ticker))];
  const n = tickers.length;
  const a = Math.floor(n * fractions[0]), b = Math.floor(n * (fractions[0] + fractions[1]));
  const sets = [new Set(tickers.slice(0, a)), new Set(tickers.slice(a, b)), new Set(tickers.slice(b))];
  return { train: rows.filter(r => sets[0].has(r.ticker)), calibration: rows.filter(r => sets[1].has(r.ticker)), test: rows.filter(r => sets[2].has(r.ticker)), tickers: sets };
}

function metrics(rows, probs) {
  let brier = 0, logLoss = 0, correct = 0;
  rows.forEach((r, i) => {
    const p = clip(probs[i]);
    brier += (p - r.label) ** 2;
    logLoss -= r.label ? Math.log(p) : Math.log(1 - p);
    correct += (p >= 0.5 ? 1 : 0) === r.label ? 1 : 0;
  });
  const n = rows.length || 1;
  return { observations: rows.length, markets: new Set(rows.map(r => r.ticker)).size, brier: brier / n, logLoss: logLoss / n, accuracy: correct / n };
}

function lcg(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }

// Market-clustered bootstrap CI of mean(Brier_model - Brier_reference).
function bootstrapDelta(rows, probs, reference, iterations = 500, seed = 1337) {
  const byMarket = new Map();
  rows.forEach((r, i) => {
    const d = (clip(probs[i]) - r.label) ** 2 - (clip(reference[i]) - r.label) ** 2;
    const m = byMarket.get(r.ticker) || { sum: 0, n: 0 };
    m.sum += d; m.n++; byMarket.set(r.ticker, m);
  });
  const markets = [...byMarket.values()], rand = lcg(seed), deltas = [];
  for (let k = 0; k < iterations; k++) {
    let sum = 0, n = 0;
    for (let j = 0; j < markets.length; j++) { const m = markets[Math.floor(rand() * markets.length)]; sum += m.sum; n += m.n; }
    deltas.push(sum / n);
  }
  deltas.sort((a, b) => a - b);
  const total = markets.reduce((a, m) => a + m.sum, 0) / markets.reduce((a, m) => a + m.n, 0);
  return { delta: total, lo: deltas[Math.floor(0.025 * iterations)], hi: deltas[Math.floor(0.975 * iterations)] };
}

// Bootstrap CI of a mean (independent values, e.g. one trade per market).
function bootstrapMean(values, iterations = 1000, seed = 7) {
  if (!values.length) return null;
  const rand = lcg(seed), means = [];
  for (let k = 0; k < iterations; k++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[Math.floor(rand() * values.length)];
    means.push(s / values.length);
  }
  means.sort((a, b) => a - b);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, lo: means[Math.floor(0.025 * iterations)], hi: means[Math.floor(0.975 * iterations)] };
}

// Solve A x = b (small dense system, Gaussian elimination with partial pivoting).
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Logistic regression by Newton-Raphson with a small ridge penalty. X rows include the intercept.
function fitLogistic(X, y, { ridge = 1e-4, iterations = 50 } = {}) {
  const k = X[0].length;
  let w = Array(k).fill(0);
  for (let it = 0; it < iterations; it++) {
    const g = Array(k).fill(0), H = Array.from({ length: k }, () => Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      const p = sigmoid(x.reduce((s, v, j) => s + v * w[j], 0));
      const e = p - y[i], s = p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a] += e * x[a];
        for (let b = a; b < k; b++) H[a][b] += s * x[a] * x[b];
      }
    }
    for (let a = 0; a < k; a++) { g[a] += ridge * w[a]; H[a][a] += ridge; for (let b = 0; b < a; b++) H[a][b] = H[b][a]; }
    const d = solve(H, g);
    w = w.map((v, j) => v - d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-9) break;
  }
  return w;
}
const predictLogistic = (w, x) => sigmoid(x.reduce((s, v, j) => s + v * w[j], 0));

// Simulated taker trading: in each market, buy 1 contract at the ask on the first
// snapshot where model EV after the taker fee is >= minEv; hold to settlement.
// NO ask = 1 - YES bid. Ignores depth and latency, so it is an upper bound.
function simulateTrades(rows, probs, { minEv = 0, feeRate = 0.07 } = {}) {
  const byMarket = new Map();
  rows.forEach((r, i) => { if (!byMarket.has(r.ticker)) byMarket.set(r.ticker, []); byMarket.get(r.ticker).push(i); });
  const trades = [];
  for (const idxs of byMarket.values()) {
    for (const i of idxs) {
      const r = rows[i], p = clip(probs[i]);
      const yesAsk = Number(r.metadata.kalshi_yes_ask), noAsk = 1 - Number(r.metadata.kalshi_yes_bid);
      const options = [['yes', p, yesAsk], ['no', 1 - p, noAsk]]
        .filter(([, , ask]) => ask > 0 && ask < 1)
        .map(([side, q, ask]) => { const fee = estimateTakerFeeDollars(ask, 1, feeRate, 1); return { side, ask, fee, ev: q - ask - fee }; })
        .sort((a, b) => b.ev - a.ev);
      const best = options[0];
      if (!best || best.ev < minEv) continue;
      const won = best.side === 'yes' ? r.label === 1 : r.label === 0;
      trades.push({ ticker: r.ticker, side: best.side, ask: best.ask, fee: best.fee, expectedEv: best.ev, pnl: (won ? 1 : 0) - best.ask - best.fee, timeRemaining: r.metadata.time_remaining_s });
      break;
    }
  }
  const pnl = trades.map(t => t.pnl);
  return {
    minEv, trades: trades.length, markets: byMarket.size,
    winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length : null,
    avgExpectedEv: trades.length ? trades.reduce((a, t) => a + t.expectedEv, 0) / trades.length : null,
    pnlPerContract: bootstrapMean(pnl), totalPnl: pnl.reduce((a, b) => a + b, 0),
  };
}

module.exports = {
  clip, logit, sigmoid, loadRows, kalshiMid, gbm, gbmShrunk, medianVolPerMinute, projectMarketOnly,
  chronologicalSplit, metrics, bootstrapDelta, bootstrapMean, solve, fitLogistic, predictLogistic, simulateTrades,
};
