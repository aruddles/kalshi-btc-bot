'use strict';
// Composite BTC/USD reference price: a proxy for CF Benchmarks' BRTI.
//
// KXBTC15M settles on BRTI, which is built from USD order books on constituent
// exchanges (Coinbase, Kraken, Bitstamp and others). Binance BTCUSDT is not a
// constituent and is quoted in USDT, so it carries a venue and USDT/USD basis.
// This module keeps the latest top-of-book from several USD venues and combines
// them as the median of fresh mids, after dropping venues that sit far from the
// median. It is an approximation; BRTI itself uses volume-weighted order-book data.

const VENUES = Object.freeze(['coinbase', 'kraken', 'bitstamp']);
const MAX_QUOTE_AGE_MS = 5000;   // a venue quote older than this is ignored
const MAX_DEVIATION = 0.005;     // drop venues more than 0.5% from the median
const MIN_VENUES = 2;            // need at least two agreeing venues for a price
const STRIKE_WINDOW_MS = 60000;  // floor_strike = 60s BRTI average before open
const MIN_WINDOW_SAMPLES = 30;

const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
function quote(bid, ask) {
  const b = num(bid), a = num(ask);
  return b && a && a >= b ? { bid: b, ask: a, mid: (a + b) / 2 } : null;
}

// ---- venue message parsers (raw parsed JSON -> {bid, ask, mid} | null) ----
const parsers = {
  // {"type":"ticker","product_id":"BTC-USD","best_bid":"...","best_ask":"..."}
  coinbase(msg) {
    return msg && msg.type === 'ticker' && msg.product_id === 'BTC-USD' ? quote(msg.best_bid, msg.best_ask) : null;
  },
  // v2: {"channel":"ticker","type":"snapshot|update","data":[{"symbol":"BTC/USD","bid":..,"ask":..}]}
  kraken(msg) {
    if (!msg || msg.channel !== 'ticker' || !Array.isArray(msg.data)) return null;
    const d = msg.data.find(x => x && x.symbol === 'BTC/USD');
    return d ? quote(d.bid, d.ask) : null;
  },
  // {"event":"data","channel":"order_book_btcusd","data":{"bids":[["p","q"],..],"asks":[..]}}
  bitstamp(msg) {
    if (!msg || msg.event !== 'data' || msg.channel !== 'order_book_btcusd' || !msg.data) return null;
    const b = msg.data.bids && msg.data.bids[0], a = msg.data.asks && msg.data.asks[0];
    return b && a ? quote(b[0], a[0]) : null;
  },
};

const ENDPOINTS = Object.freeze({
  coinbase: { url: 'wss://ws-feed.exchange.coinbase.com', subscribe: { type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] } },
  kraken: { url: 'wss://ws.kraken.com/v2', subscribe: { method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'], event_trigger: 'bbo' } } },
  bitstamp: { url: 'wss://ws.bitstamp.net', subscribe: { event: 'bts:subscribe', data: { channel: 'order_book_btcusd' } } },
});

function median(xs) {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// quotes: { venue: { mid, ts } }. Returns { price, venues, dispersion } or null.
function compositePrice(quotes, now = Date.now(), { maxAgeMs = MAX_QUOTE_AGE_MS, maxDeviation = MAX_DEVIATION, minVenues = MIN_VENUES } = {}) {
  const fresh = Object.entries(quotes || {})
    .filter(([, q]) => q && num(q.mid) && Number.isFinite(q.ts) && now - q.ts <= maxAgeMs)
    .map(([venue, q]) => ({ venue, mid: q.mid }));
  if (fresh.length < minVenues) return null;
  const m0 = median(fresh.map(x => x.mid));
  const kept = fresh.filter(x => Math.abs(x.mid / m0 - 1) <= maxDeviation);
  if (kept.length < minVenues) return null;
  const mids = kept.map(x => x.mid);
  return {
    price: median(mids),
    venues: kept.map(x => x.venue).sort(),
    excluded: fresh.filter(x => !kept.includes(x)).map(x => x.venue),
    dispersion: Math.max(...mids) - Math.min(...mids),
  };
}

// Mean price of samples with startMs <= timestamp < endMs.
function windowAverage(history, startMs, endMs) {
  let sum = 0, n = 0;
  for (const s of history || []) {
    if (s && s.timestamp >= startMs && s.timestamp < endMs && s.price > 0) { sum += s.price; n++; }
  }
  return n ? { mean: sum / n, n } : { mean: null, n: 0 };
}

// How well a feed reproduces Kalshi's official strike (the 60s BRTI average before open).
function strikeError(history, market, minSamples = MIN_WINDOW_SAMPLES) {
  const floor = num(market && market.floorStrike);
  if (!floor || !Number.isFinite(market.openTime)) return null;
  const w = windowAverage(history, market.openTime - STRIKE_WINDOW_MS, market.openTime);
  return w.n >= minSamples ? { estimate: w.mean, error: w.mean - floor, samples: w.n } : null;
}

// Rolling record of strike errors for the composite feed and Binance, one entry per market.
class StrikeTracker {
  constructor({ maxEntries = 300 } = {}) { this.maxEntries = maxEntries; this.entries = []; this.seen = new Set(); }

  // Measures each market once, shortly after it opens. Markets whose pre-open
  // minute was not observed by both feeds are skipped (and not retried).
  observe(markets, { reference, binance, now = Date.now() }) {
    for (const m of markets || []) {
      if (!m || !m.ticker || this.seen.has(m.ticker) || !Number.isFinite(m.openTime) || now < m.openTime + 2000) continue;
      this.seen.add(m.ticker);
      const r = strikeError(reference, m), b = strikeError(binance, m);
      if (!r || !b) continue;
      this.entries.push({ ticker: m.ticker, floorStrike: m.floorStrike, referenceError: r.error, binanceError: b.error, at: now });
      if (this.entries.length > this.maxEntries) this.entries.shift();
    }
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-1000));
  }

  // Median signed error of the composite feed (USD); used to correct its basis to BRTI.
  referenceBias(minEntries = 20) {
    return this.entries.length >= minEntries ? median(this.entries.map(e => e.referenceError)) : 0;
  }

  summary() {
    const stats = key => {
      const xs = this.entries.map(e => e[key]);
      if (!xs.length) return null;
      const abs = xs.map(Math.abs);
      return { meanAbsError: abs.reduce((a, b) => a + b, 0) / abs.length, medianError: median(xs), maxAbsError: Math.max(...abs) };
    };
    return { markets: this.entries.length, reference: stats('referenceError'), binance: stats('binanceError'), recent: this.entries.slice(-10) };
  }
}

module.exports = {
  VENUES, ENDPOINTS, MAX_QUOTE_AGE_MS, MAX_DEVIATION, MIN_VENUES, STRIKE_WINDOW_MS,
  parsers, compositePrice, windowAverage, strikeError, StrikeTracker, median,
};
