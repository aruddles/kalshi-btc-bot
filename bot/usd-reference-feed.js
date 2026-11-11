'use strict';
// Live composite BTC/USD feed (BRTI proxy) from Coinbase, Kraken and Bitstamp.
// Exposes the same surface the models use on BinanceFeed: priceHistory,
// getRecentVolatility() and getPriceAt(). Market data only; it never trades.

const WebSocket = require('ws');
const { VENUES, ENDPOINTS, parsers, compositePrice } = require('../lib/reference-price');
const { estimateVolatility } = require('../lib/volatility');

const SAMPLE_MS = 1000;
const MAX_HISTORY = 3600;          // 1 hour of 1s samples
const STALL_MS = 30000;            // reconnect a venue that has gone quiet
const MAX_RECONNECT_MS = 30000;

class UsdReferenceFeed {
  // onQuote(venue, { bid, ask, mid }, ts) is called for every parsed top-of-book update (used by the capture).
  constructor({ venues = VENUES, WebSocketImpl = WebSocket, now = () => Date.now(), sampleMs = SAMPLE_MS, logger = console, onQuote = null } = {}) {
    this.venues = venues.filter(v => ENDPOINTS[v] && parsers[v]);
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.sampleMs = sampleMs;
    this.logger = logger;
    this.onQuote = onQuote;
    this.running = false;
    this.quotes = {};              // venue -> { bid, ask, mid, ts }
    this.conn = {};                // venue -> { ws, connected, delay, timer, lastMessageAt, messages }
    this.priceHistory = [];        // [{ price, timestamp, venues }]
    this.latest = null;            // last composite sample
    this.sampleTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const v of this.venues) this._connect(v);
    this.sampleTimer = setInterval(() => { this.sample(); this._checkStalls(); }, this.sampleMs);
    this.sampleTimer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    for (const v of this.venues) {
      const c = this.conn[v];
      if (!c) continue;
      clearTimeout(c.timer);
      try { c.ws?.terminate?.(); } catch (_) { /* already closed */ }
      c.connected = false;
    }
  }

  // Record one venue message (also used directly by tests).
  handleMessage(venue, raw) {
    let msg;
    try { msg = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw; } catch (_) { return; }
    const c = this.conn[venue];
    if (c) { c.lastMessageAt = this.now(); c.messages++; }
    if (venue === 'bitstamp' && msg?.event === 'bts:request_reconnect') { this._reconnect(venue); return; }
    const q = parsers[venue]?.(msg);
    if (q) {
      const ts = this.now();
      this.quotes[venue] = { ...q, ts };
      try { this.onQuote?.(venue, q, ts); } catch (_) { /* observer errors never break the feed */ }
    }
  }

  // Take one composite sample into priceHistory. Returns the sample or null.
  sample() {
    const now = this.now();
    const c = compositePrice(this.quotes, now);
    if (!c) { this.latest = null; return null; }
    const s = { price: c.price, timestamp: now, venues: c.venues.length };
    this.latest = { ...c, timestamp: now };
    const last = this.priceHistory[this.priceHistory.length - 1];
    if (!last || now - last.timestamp >= this.sampleMs * 0.9) {
      this.priceHistory.push(s);
      if (this.priceHistory.length > MAX_HISTORY) this.priceHistory.shift();
    }
    return s;
  }

  isHealthy(maxAgeMs = 3000) { return !!this.latest && this.now() - this.latest.timestamp <= maxAgeMs; }
  getPrice() { return this.isHealthy() ? this.latest.price : null; }

  getRecentVolatility(windowSeconds = 300) {
    return estimateVolatility(this.priceHistory, windowSeconds, { now: this.now() });
  }

  getPriceAt(timestamp, toleranceMs = 2500) {
    let nearest = null;
    for (const s of this.priceHistory) {
      if (!nearest || Math.abs(s.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp)) nearest = s;
    }
    return nearest && Math.abs(nearest.timestamp - timestamp) <= toleranceMs ? { price: nearest.price, timestamp: nearest.timestamp } : null;
  }

  getStatus() {
    const now = this.now();
    return {
      healthy: this.isHealthy(),
      price: this.latest?.price ?? null,
      venuesUsed: this.latest?.venues ?? [],
      excluded: this.latest?.excluded ?? [],
      dispersion: this.latest?.dispersion ?? null,
      samples: this.priceHistory.length,
      venues: Object.fromEntries(this.venues.map(v => {
        const q = this.quotes[v], c = this.conn[v];
        return [v, { connected: !!c?.connected, mid: q?.mid ?? null, ageMs: q ? now - q.ts : null, messages: c?.messages || 0 }];
      })),
    };
  }

  // ---- connection management ----
  _connect(venue) {
    if (!this.running) return;
    const { url, subscribe } = ENDPOINTS[venue];
    const c = this.conn[venue] || (this.conn[venue] = { delay: 1000, messages: 0 });
    c.lastMessageAt = this.now();
    let ws;
    try { ws = new this.WebSocketImpl(url); } catch (e) { this._scheduleReconnect(venue, e.message); return; }
    c.ws = ws;
    ws.on('open', () => {
      c.connected = true;
      c.delay = 1000;
      try { ws.send(JSON.stringify(subscribe)); } catch (e) { this._reconnect(venue); }
    });
    ws.on('message', data => { if (c.ws === ws) this.handleMessage(venue, data); });
    ws.on('error', err => this.logger.warn?.(`[UsdReference] ${venue} error: ${err.message}`));
    ws.on('close', () => {
      if (c.ws !== ws) return;
      c.connected = false;
      delete this.quotes[venue];
      this._scheduleReconnect(venue, 'closed');
    });
  }

  _scheduleReconnect(venue, why) {
    const c = this.conn[venue];
    if (!this.running || !c || c.timer) return;
    const delay = c.delay;
    c.delay = Math.min(MAX_RECONNECT_MS, c.delay * 2);
    this.logger.warn?.(`[UsdReference] ${venue} ${why}; reconnecting in ${Math.round(delay / 1000)}s`);
    c.timer = setTimeout(() => { c.timer = null; this._connect(venue); }, delay);
    c.timer.unref?.();
  }

  _reconnect(venue) {
    const c = this.conn[venue];
    if (!c) return;
    const old = c.ws;
    c.ws = null;
    c.connected = false;
    delete this.quotes[venue];
    try { old?.terminate?.(); } catch (_) { /* ignore */ }
    this._scheduleReconnect(venue, 'reconnect requested');
  }

  _checkStalls() {
    const now = this.now();
    for (const v of this.venues) {
      const c = this.conn[v];
      if (c?.connected && now - c.lastMessageAt > STALL_MS) this._reconnect(v);
    }
  }
}

module.exports = UsdReferenceFeed;
