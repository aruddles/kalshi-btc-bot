'use strict';
// Settlement-aware P(YES) for KXBTC15M.
//
// Contract rule: YES iff the simple average of the 60 one-second CF BRTI values
// before close is >= the 60-second BRTI average before open (Kalshi floor_strike).
//
// The legacy GBM model compares a single Binance tick at open with the current
// tick and uses variance sigma^2 * t. That misstates both the strike and the
// remaining variance, most of all in the final two minutes:
//   t >= 60s:  A - S_now ~ N(0, s^2 * ((t - 60) + 60/3))
//   t <  60s:  A = ((60 - t) * observedAvg + t * S_now) / 60 + N(0, s^2 * t^3 / (3 * 60^2))
// where s is the per-second absolute volatility. Binance BTCUSDT is a proxy for
// BRTI; to keep strike and current price in the same units the strike is the
// Binance 60s average over the same pre-open minute. The gap to floor_strike is
// reported as `basis` (USDT/USD + venue difference) for diagnostics only.

const WINDOW_SEC = 60;
const MIN_WINDOW_SAMPLES = 30;
const { normalCdf } = require('./normal');

// Mean of samples with startMs <= timestamp < endMs.
function windowAverage(history, startMs, endMs) {
  let sum = 0, n = 0;
  for (const s of history || []) {
    if (s && s.timestamp >= startMs && s.timestamp < endMs && Number.isFinite(s.price) && s.price > 0) { sum += s.price; n++; }
  }
  return n ? { mean: sum / n, n } : { mean: null, n: 0 };
}

// Strike in Binance units: average of the minute before open (mirrors floor_strike construction).
function referenceStrike(history, openTimeMs, minSamples = MIN_WINDOW_SAMPLES) {
  if (!Number.isFinite(openTimeMs)) return null;
  const w = windowAverage(history, openTimeMs - WINDOW_SEC * 1000, openTimeMs);
  return w.n >= minSamples ? { price: w.mean, samples: w.n, source: 'binance_preopen_60s_avg' } : null;
}

// Pure probability. sigmaPerSqrtSec is log-return volatility per sqrt(second).
function settlementProbability({ currentPrice, strike, timeRemainingSec, sigmaPerSqrtSec, observedAvg = null }) {
  if (![currentPrice, strike, timeRemainingSec, sigmaPerSqrtSec].every(Number.isFinite) || currentPrice <= 0 || strike <= 0 || sigmaPerSqrtSec < 0) return null;
  const t = Math.max(0, timeRemainingSec);
  const s = sigmaPerSqrtSec * currentPrice;
  let mean, variance;
  if (t >= WINDOW_SEC) {
    mean = currentPrice;
    variance = s * s * ((t - WINDOW_SEC) + WINDOW_SEC / 3);
  } else {
    const locked = Number.isFinite(observedAvg) && observedAvg > 0 ? observedAvg : currentPrice;
    mean = ((WINDOW_SEC - t) * locked + t * currentPrice) / WINDOW_SEC;
    variance = s * s * t ** 3 / (3 * WINDOW_SEC ** 2);
  }
  const sd = Math.sqrt(variance);
  const raw = sd > 1e-9 ? normalCdf((mean - strike) / sd) : (mean >= strike ? 1 : 0);
  const probUp = Math.max(0.01, Math.min(0.99, raw));
  return { probUp, probDown: 1 - probUp, expectedSettlement: mean, sd, z: sd > 1e-9 ? (mean - strike) / sd : null };
}

// Convenience wrapper using a Binance feed (priceHistory + getRecentVolatility).
// Returns null (fail-safe) when the pre-open reference minute was not observed.
function settlementProbabilityForMarket({ market, currentPrice, now = Date.now(), feed }) {
  if (!market || !feed || !Number.isFinite(market.openTime) || !Number.isFinite(market.closeTime)) return null;
  const history = feed.priceHistory || [];
  const ref = referenceStrike(history, market.openTime);
  if (!ref) return null;
  const durationSec = (market.closeTime - market.openTime) / 1000;
  const sigmaWindow = feed.getRecentVolatility(durationSec);
  const sigmaPerSqrtSec = sigmaWindow / Math.sqrt(durationSec);
  const timeRemainingSec = (market.closeTime - now) / 1000;
  const observed = timeRemainingSec < WINDOW_SEC ? windowAverage(history, market.closeTime - WINDOW_SEC * 1000, now + 1) : { mean: null, n: 0 };
  const p = settlementProbability({ currentPrice, strike: ref.price, timeRemainingSec, sigmaPerSqrtSec, observedAvg: observed.n ? observed.mean : null });
  if (!p) return null;
  const floorStrike = Number.isFinite(market.floorStrike) && market.floorStrike > 0 ? market.floorStrike : null;
  return {
    ...p, strike: ref.price, strikeSource: ref.source, strikeSamples: ref.samples,
    floorStrike, basis: floorStrike ? ref.price - floorStrike : null,
    observedSamples: observed.n, sigma: sigmaWindow, timeRemainingSec,
  };
}

// Settlement probability against Kalshi's official strike (floor_strike, itself the 60s
// BRTI average before open), with a composite USD feed (lib/reference-price) standing in
// for BRTI. No pre-open observation is needed. `bias` is the feed's typical
// (feed - BRTI) error in USD, removed before comparing with the strike.
function settlementProbabilityFromReference({ market, feed, now = Date.now(), bias = 0 }) {
  if (!market || !feed || typeof feed.isHealthy !== 'function' || !feed.isHealthy()) return null;
  const strike = Number(market.floorStrike);
  if (!(strike > 0) || !Number.isFinite(market.openTime) || !Number.isFinite(market.closeTime)) return null;
  const timeRemainingSec = (market.closeTime - now) / 1000;
  if (!(timeRemainingSec > 0)) return null;
  const durationSec = (market.closeTime - market.openTime) / 1000;
  const b = Number.isFinite(bias) ? bias : 0;
  const referencePrice = feed.getPrice();
  const sigmaWindow = feed.getRecentVolatility(durationSec);
  const observed = timeRemainingSec < WINDOW_SEC ? windowAverage(feed.priceHistory, market.closeTime - WINDOW_SEC * 1000, now + 1) : { mean: null, n: 0 };
  const p = settlementProbability({
    currentPrice: referencePrice - b, strike, timeRemainingSec,
    sigmaPerSqrtSec: sigmaWindow / Math.sqrt(durationSec),
    observedAvg: observed.n ? observed.mean - b : null,
  });
  if (!p) return null;
  return { ...p, strike, strikeSource: 'kalshi_floor_strike', referencePrice, bias: b, observedSamples: observed.n, sigma: sigmaWindow, timeRemainingSec };
}

module.exports = { WINDOW_SEC, normalCdf, windowAverage, referenceStrike, settlementProbability, settlementProbabilityForMarket, settlementProbabilityFromReference };
