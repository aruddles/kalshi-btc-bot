'use strict';
// Shadow-only "market context" feeds: information the bot does not use yet.
//   - Spot order book + trade flow from two BRTI constituent exchanges (Coinbase, Kraken)
//   - Deribit: DVOL implied-volatility index, perpetual funding, open interest, basis
//   - Kalshi: full order-book depth and public trade tape for the active market
// Logged to data/market-context.jsonl beside each collector snapshot. Never read by
// any trading code. Every request has its own error handling: a failure here cannot
// reach the trading client's 401 hard-halt.
//
// No result may be read from this file for a research decision before the test that
// uses it is pre-registered in RESEARCH_LEDGER.md.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { normalizeSnapshot, executableQuotes } = require('./kalshi-orderbook');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'market-context.jsonl');
const file = () => process.env.MARKET_CONTEXT_LOG || DEFAULT_FILE;
// Under `node --test`, write only when a test points MARKET_CONTEXT_LOG at a temp file.
const enabled = () => !process.env.NODE_TEST_CONTEXT || !!process.env.MARKET_CONTEXT_LOG;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

function append(row) {
  if (!enabled()) return;
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFile(f, JSON.stringify(row) + '\n', () => {});
}

// ---- Order book ------------------------------------------------------------
// Levels may be [price, size, ...] arrays (Coinbase Exchange, Kraken) or
// {price, size} objects (Coinbase public product_book).
function levels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(l => (Array.isArray(l) ? { p: num(l[0]), q: num(l[1]) } : { p: num(l?.price), q: num(l?.size ?? l?.qty) }))
    .filter(l => l.p > 0 && l.q > 0);
}

// imbalance = (bid size - ask size) / (bid size + ask size) over the top N levels:
// +1 = all resting size on the bid, -1 = all on the ask.
function bookStats(rawBids, rawAsks) {
  const bids = levels(rawBids).sort((a, b) => b.p - a.p), asks = levels(rawAsks).sort((a, b) => a.p - b.p);
  if (!bids.length || !asks.length || bids[0].p >= asks[0].p) return null;
  const mid = (bids[0].p + asks[0].p) / 2;
  const imb = n => {
    const b = bids.slice(0, n).reduce((s, l) => s + l.q, 0), a = asks.slice(0, n).reduce((s, l) => s + l.q, 0);
    return round((b - a) / (b + a), 4);
  };
  const n = Math.min(bids.length, asks.length, 50);
  return {
    mid: round(mid, 2),
    sp_bps: round((asks[0].p - bids[0].p) / mid * 1e4, 3),
    imb1: imb(1), imb10: imb(10), imb50: imb(50),
    // How far from the mid the 50-level window reaches (narrower side), in bps.
    span_bps: round(Math.min(mid - bids[n - 1].p, asks[n - 1].p - mid) / mid * 1e4, 2),
  };
}

// ---- Trade flow ------------------------------------------------------------
// Rolling window of trades; `buy` = the taker (aggressor) bought.
class TradeWindow {
  constructor(keepMs = 120000) { this.keepMs = keepMs; this.trades = []; this.seen = new Set(); }

  add(list) {
    for (const t of list || []) {
      if (!t || t.id == null || this.seen.has(t.id) || !(t.t > 0) || !(t.q > 0)) continue;
      this.seen.add(t.id); this.trades.push(t);
    }
    this.trades.sort((a, b) => a.t - b.t);
    const newest = this.trades.length ? this.trades[this.trades.length - 1].t : 0;
    while (this.trades.length && this.trades[0].t < newest - this.keepMs) this.seen.delete(this.trades.shift().id);
  }

  // Signed taker volume (buys - sells) and total volume over the trailing windows.
  stats(now, windowsS = [5, 30, 60], digits = 4) {
    const out = {};
    for (const w of windowsS) {
      let signed = 0, total = 0, n = 0;
      for (const t of this.trades) if (t.t > now - w * 1000 && t.t <= now) { signed += t.buy ? t.q : -t.q; total += t.q; n++; }
      out[`f${w}`] = round(signed, digits); out[`v${w}`] = round(total, digits); out[`n${w}`] = n;
    }
    return out;
  }
}

const ms = v => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

// Coinbase Exchange /products/{id}/trades: `side` is the MAKER side, so
// side === 'sell' means the taker bought.
function parseCoinbaseTrades(body) {
  return (Array.isArray(body) ? body : []).map(t => ({ id: t.trade_id, t: ms(t.time), p: num(t.price), q: num(t.size), buy: t.side === 'sell' }));
}
function parseCoinbaseBook(body) {
  const b = body?.pricebook || body;
  return bookStats(b?.bids, b?.asks);
}

// Kraken /0/public/Depth and /Trades: result is keyed by pair name.
// Trade rows: [price, volume, time_s, 'b'|'s' (taker side), 'm'|'l', misc, trade_id].
function krakenPair(body) {
  const r = body?.result; if (!r) return null;
  const k = Object.keys(r).find(x => x !== 'last'); return k ? r[k] : null;
}
function parseKrakenBook(body) { const p = krakenPair(body); return p ? bookStats(p.bids, p.asks) : null; }
function parseKrakenTrades(body) {
  const p = krakenPair(body);
  return (Array.isArray(p) ? p : []).map(r => ({ id: r[6] ?? `${r[2]}:${r[0]}:${r[1]}`, t: num(r[2]) * 1000, p: num(r[0]), q: num(r[1]), buy: r[3] === 'b' }));
}

// ---- Deribit ---------------------------------------------------------------
function parseDeribitTicker(body) {
  const r = body?.result; if (!r || !(num(r.mark_price) > 0)) return null;
  const mark = num(r.mark_price), index = num(r.index_price);
  return {
    fund8h: num(r.funding_8h), fund_now: num(r.current_funding),
    oi_usd: num(r.open_interest), mark: round(mark, 2),
    basis_bps: index > 0 ? round((mark - index) / index * 1e4, 3) : null,
    t: num(r.timestamp),
  };
}
// DVOL candles: [timestamp_ms, open, high, low, close]; newest close wins.
function parseDvol(body) {
  const d = body?.result?.data; if (!Array.isArray(d) || !d.length) return null;
  const last = d.reduce((a, b) => (b[0] > a[0] ? b : a));
  return num(last[4]) > 0 ? { dvol: num(last[4]), t: num(last[0]) } : null;
}

// ---- Kalshi ----------------------------------------------------------------
// Depth = contracts resting within `band` dollars of the best price on that side.
function kalshiBookStats(body, band = 0.05) {
  let q;
  try { q = executableQuotes(normalizeSnapshot(body)); } catch { return null; }
  const d = q?.depth; if (!d) return null;
  const side = (lv, best, dir) => {
    let near = 0, total = 0;
    for (const l of lv) { total += l.quantity; if (best && dir * (best.price - l.price) <= band + 1e-9) near += l.quantity; }
    return { near: round(near, 0), total: round(total, 0), levels: lv.length };
  };
  const b = side(d.yesBids, q.yesBid, 1), a = side(d.yesAsks, q.yesAsk, -1);
  if (!b.levels && !a.levels) return null;
  return {
    yb: q.yesBid?.price ?? null, ya: q.yesAsk?.price ?? null,
    yb_near: b.near, ya_near: a.near, yb_total: b.total, ya_total: a.total, yb_lv: b.levels, ya_lv: a.levels,
  };
}
// Trade tape: `buy` = the taker took the YES side.
function parseKalshiTrades(body) {
  return (body?.trades || []).map(t => ({
    id: t.trade_id, t: ms(t.created_time), p: num(t.yes_price_dollars), q: num(t.count_fp ?? t.count),
    buy: (t.taker_outcome_side ?? t.taker_side) === 'yes',
  }));
}

// ---- Polling ---------------------------------------------------------------
// One isolated feed: its own timer, failure counter and back-off. Errors are
// swallowed and counted; nothing is ever rethrown to the caller.
class Feed {
  constructor(name, intervalMs, fn, log = console) { Object.assign(this, { name, intervalMs, fn, log }); this.failures = 0; this.lastOk = 0; this.lastError = null; this.timer = null; }
  async poll() {
    try {
      await this.fn();
      if (this.failures >= 3) this.log.log(`[Context] ${this.name} feed recovered`);
      this.failures = 0; this.lastError = null; this.lastOk = Date.now();
      return true;
    } catch (err) {
      this.failures++;
      this.lastError = err?.response?.status ? `HTTP ${err.response.status}` : (err?.message || 'error');
      if (this.failures === 3 || this.failures % 120 === 0) this.log.warn(`[Context] ${this.name} failing (${this.lastError}); shadow data only, trading unaffected`);
      return false;
    }
  }
  start() {
    if (this.timer) return;
    const tick = async () => { await this.poll(); this.timer = setTimeout(tick, this.failures >= 3 ? 60000 : this.intervalMs); this.timer.unref?.(); };
    tick();
  }
  stop() { clearTimeout(this.timer); this.timer = null; }
}

const URLS = {
  coinbaseBook: 'https://api.coinbase.com/api/v3/brokerage/market/product_book',
  coinbaseTrades: 'https://api.exchange.coinbase.com/products/BTC-USD/trades',
  krakenBook: 'https://api.kraken.com/0/public/Depth',
  krakenTrades: 'https://api.kraken.com/0/public/Trades',
  deribit: 'https://www.deribit.com/api/v2/public',
};
const KALSHI_BOOK = t => `/trade-api/v2/markets/${t}/orderbook`;
const KALSHI_TRADES = '/trade-api/v2/markets/trades';

class MarketContext {
  constructor({ client = null, http = axios, log = console, intervalMs = 5000 } = {}) {
    Object.assign(this, { client, http, log });
    this.state = {};                                   // name -> { data, at }
    this.flow = { cb: new TradeWindow(), kr: new TradeWindow() };
    this.kalshi = new Map();                           // ticker -> { closeTime, book, bookAt, tape, tapeAt }
    const get = (url, params, headers) => this.http.get(url, { params, headers, timeout: 4000 }).then(r => r.data);
    const set = (k, data) => { if (!data) throw new Error('unexpected response shape'); this.state[k] = { data, at: Date.now() }; };
    this.feeds = [
      new Feed('coinbase-book', intervalMs, async () => set('cbBook', parseCoinbaseBook(await get(URLS.coinbaseBook, { product_id: 'BTC-USD', limit: 100 }))), log),
      new Feed('coinbase-trades', intervalMs, async () => { const t = parseCoinbaseTrades(await get(URLS.coinbaseTrades, { limit: 200 })); if (!t.length) throw new Error('no trades'); this.flow.cb.add(t); this.state.cbTrades = { at: Date.now() }; }, log),
      new Feed('kraken-book', intervalMs, async () => set('krBook', parseKrakenBook(await get(URLS.krakenBook, { pair: 'XBTUSD', count: 100 }))), log),
      new Feed('kraken-trades', intervalMs, async () => { const t = parseKrakenTrades(await get(URLS.krakenTrades, { pair: 'XBTUSD', count: 200 })); if (!t.length) throw new Error('no trades'); this.flow.kr.add(t); this.state.krTrades = { at: Date.now() }; }, log),
      new Feed('deribit-perp', 10000, async () => set('perp', parseDeribitTicker(await get(`${URLS.deribit}/ticker`, { instrument_name: 'BTC-PERPETUAL' }))), log),
      new Feed('deribit-dvol', 30000, async () => { const now = Date.now(); set('dvol', parseDvol(await get(`${URLS.deribit}/get_volatility_index_data`, { currency: 'BTC', start_timestamp: now - 600000, end_timestamp: now, resolution: '60' }))); }, log),
      new Feed('kalshi-book', intervalMs, () => this._kalshiBooks(get), log),
      new Feed('kalshi-tape', intervalMs, () => this._kalshiTapes(get), log),
    ];
  }

  // The collector tells us which markets are live; closed ones are dropped.
  track(ticker, closeTime) {
    if (!ticker) return;
    if (!this.kalshi.has(ticker)) this.kalshi.set(ticker, { closeTime, tape: new TradeWindow() });
    const now = Date.now();
    for (const [t, m] of this.kalshi) if (m.closeTime && m.closeTime < now - 60000) this.kalshi.delete(t);
  }

  async _kalshiBooks(get) {
    if (!this.client?.generateAuth || !this.kalshi.size) return;
    for (const [ticker, m] of this.kalshi) {
      const p = KALSHI_BOOK(ticker);
      // Own signed request (same reason as lib/cf-index.js): never goes through the
      // trading client, so an auth error here cannot halt trading.
      const { headers } = this.client.generateAuth('GET', p);
      const s = kalshiBookStats(await get(`${this.client.baseUrl}${p}`, { depth: 0 }, headers));
      if (s) { m.book = s; m.bookAt = Date.now(); }
    }
  }

  async _kalshiTapes(get) {
    if (!this.client?.baseUrl || !this.kalshi.size) return;
    for (const [ticker, m] of this.kalshi) {
      m.tape.add(parseKalshiTrades(await get(`${this.client.baseUrl}${KALSHI_TRADES}`, { ticker, limit: 200 })));
      m.tapeAt = Date.now();
    }
  }

  start() { for (const f of this.feeds) f.start(); }
  stop() { for (const f of this.feeds) f.stop(); }

  // One flat-ish row for the log. Stale pieces (older than maxAgeMs) are null.
  snapshot(ticker, now = Date.now(), maxAgeMs = 20000) {
    const fresh = (k, max = maxAgeMs) => { const s = this.state[k]; return s && now - s.at <= max ? s : null; };
    const venue = (book, trades, win) => {
      const b = fresh(book), t = fresh(trades);
      if (!b && !t) return null;
      return { ...(b ? b.data : {}), ...(t ? win.stats(now) : {}), book_age: b ? now - b.at : null, trades_age: t ? now - t.at : null };
    };
    const perp = fresh('perp', 60000), dvol = fresh('dvol', 180000), m = this.kalshi.get(ticker);
    const kb = m?.book && now - m.bookAt <= maxAgeMs ? { ...m.book, age: now - m.bookAt } : null;
    const kt = m?.tapeAt && now - m.tapeAt <= maxAgeMs ? { ...m.tape.stats(now, [30, 60], 0), last: m.tape.trades.length ? m.tape.trades[m.tape.trades.length - 1].p : null, age: now - m.tapeAt } : null;
    return {
      cb: venue('cbBook', 'cbTrades', this.flow.cb),
      kr: venue('krBook', 'krTrades', this.flow.kr),
      perp: perp ? { ...perp.data, age: now - perp.at } : null,
      dvol: dvol ? dvol.data.dvol : null,
      kb, kt,
    };
  }

  health() { return Object.fromEntries(this.feeds.map(f => [f.name, { failures: f.failures, lastOk: f.lastOk, lastError: f.lastError }])); }
}

module.exports = {
  append, bookStats, TradeWindow, parseCoinbaseBook, parseCoinbaseTrades, parseKrakenBook, parseKrakenTrades,
  parseDeribitTicker, parseDvol, kalshiBookStats, parseKalshiTrades, Feed, MarketContext, URLS,
};
