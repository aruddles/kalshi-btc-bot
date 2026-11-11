'use strict';
// Realized-volatility estimation for the Binance ~1s price history.
//
// v3.2 changes vs the old BinanceFeed.getRecentVolatility:
//  - Time-normalised: variance = sum(r^2) / sum(dt). Returns that span a feed gap
//    count for their real duration instead of being averaged as one "sample".
//  - Shrinkage: the trailing-window estimate is blended (in variance) with the
//    longer-history estimate. On the 5k-market historical set (leak-corrected,
//    chronological 60/40 split) a 50/50 blend cut GBM log loss 0.455 -> 0.445 on
//    the test split; noisy short windows were the main source of overconfidence.

const DEFAULT_SIGMA_15M = 0.0015; // fallback ~0.15% per 15 minutes
const MIN_SAMPLES = 10;
const SHORT_WEIGHT = 0.5;

// Sum of squared log returns and elapsed seconds over samples with timestamp >= fromMs.
function returnStats(history, fromMs = -Infinity) {
  let sumSq = 0, seconds = 0, n = 0, prev = null;
  for (const s of history || []) {
    if (!s || !(s.price > 0) || !Number.isFinite(s.timestamp) || s.timestamp < fromMs) continue;
    if (prev && s.timestamp > prev.timestamp) {
      const r = Math.log(s.price / prev.price);
      sumSq += r * r;
      seconds += (s.timestamp - prev.timestamp) / 1000;
      n++;
    }
    prev = s;
  }
  return { sumSq, seconds, n };
}

// Variance per second, or null when fewer than MIN_SAMPLES returns are available.
function variancePerSecond(stats) {
  return stats.n >= MIN_SAMPLES && stats.seconds > 0 ? stats.sumSq / stats.seconds : null;
}

// Log-return volatility over `windowSeconds`, i.e. sigma * sqrt(windowSeconds).
function estimateVolatility(history, windowSeconds = 300, { now = Date.now(), shortWeight = SHORT_WEIGHT, fallback = DEFAULT_SIGMA_15M * Math.sqrt(windowSeconds / 900) } = {}) {
  const shortVar = variancePerSecond(returnStats(history, now - windowSeconds * 1000));
  const longVar = variancePerSecond(returnStats(history));
  let v;
  if (shortVar != null && longVar != null) v = shortWeight * shortVar + (1 - shortWeight) * longVar;
  else v = shortVar ?? longVar;
  if (v == null || !(v > 0)) return fallback;
  return Math.sqrt(v * windowSeconds);
}

module.exports = { estimateVolatility, returnStats, DEFAULT_SIGMA_15M, MIN_SAMPLES, SHORT_WEIGHT };
