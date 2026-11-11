'use strict';
// Opening and current BTC price for a market, always taken from the SAME feed.
//
// The GBM compares the price now with the price at market open, so both must come
// from one source: the composite USD feed and Binance BTCUSDT differ by tens of
// dollars. The composite feed (lib/reference-price) is preferred because it samples
// every second; Binance.US ticks were observed 26s apart, which left many markets
// without an opening price at all.

const OPEN_TOLERANCE_MS = 2500;
const SOURCES = Object.freeze({
  usd_reference_at_market_open: 'reference',
  binance_at_market_open: 'binance',
});

function feedsFrom(registry) {
  const get = name => { try { return registry?.get(name)?.getFeed?.() || null; } catch (_) { return null; } };
  return { reference: get('usd-reference-feed'), binance: get('binance-price-feed') };
}

// Records the opening price once per market: composite feed first, Binance second.
// Never substitutes a later price for a missed open. Returns the source used, or null.
function recordOpenPrice(state, market, { reference, binance } = {}) {
  if (!state || !market?.ticker || !Number.isFinite(market.openTime)) return null;
  state.marketOpenPrices ||= {};
  state.marketOpenPriceMeta ||= {};
  if (state.marketOpenPrices[market.ticker]) return state.marketOpenPriceMeta[market.ticker]?.source || null;
  for (const [source, feed] of [['usd_reference_at_market_open', reference], ['binance_at_market_open', binance]]) {
    const at = feed?.getPriceAt?.(market.openTime, OPEN_TOLERANCE_MS);
    if (at && at.price > 0) {
      state.marketOpenPrices[market.ticker] = at.price;
      state.marketOpenPriceMeta[market.ticker] = { source, timestamp: at.timestamp };
      return source;
    }
  }
  return null;
}

// { openPrice, currentPrice, feed, source } from the feed that recorded the open,
// or null when there is no valid open or that feed has no current price.
function marketPriceInputs(market, state, { reference, binance } = {}) {
  const open = state?.marketOpenPrices?.[market?.ticker];
  const meta = state?.marketOpenPriceMeta?.[market?.ticker];
  const kind = meta && SOURCES[meta.source];
  if (!(open > 0) || !kind || !Number.isFinite(market.openTime) || Math.abs(meta.timestamp - market.openTime) > OPEN_TOLERANCE_MS) return null;
  if (kind === 'reference') {
    const current = reference?.isHealthy?.() ? reference.getPrice() : null;
    return current > 0 ? { openPrice: open, currentPrice: current, feed: reference, source: meta.source } : null;
  }
  const current = Number(state.btcPrice?.binance);
  return current > 0 && binance ? { openPrice: open, currentPrice: current, feed: binance, source: meta.source } : null;
}

module.exports = { OPEN_TOLERANCE_MS, SOURCES, feedsFrom, recordOpenPrice, marketPriceInputs };
