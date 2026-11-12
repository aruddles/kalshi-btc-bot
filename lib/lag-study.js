'use strict';
// Lead-lag study: does Kalshi's KXBTC15M order book lag BTC spot, and could a taker
// profit by buying the stale side? Read-only analysis of a capture file
// (scripts/capture-kalshi-history.js with usd_reference_quote events).
//
// All times are local receive times (received_at_ms), i.e. what this machine saw.
//   BTC   = composite of Coinbase/Kraken/Bitstamp mids (lib/reference-price).
//   Kalshi = executable YES bid/ask from the reconstructed order book (derived_quote),
//            treated as invalid between a sequence gap and the next snapshot.
//
// Rules fixed before any data (2026-11-11):
//   Jump event: composite moves >= jumpUsd within jumpWindowMs, at least 60s before the
//     front market closes, at least cooldownMs after the previous event.
//   Response time: from the jump until Kalshi's YES mid has moved >= 1c in the jump's
//     direction, relative to the mid just before the move started.
//   Markout: buy 1 contract of the jump side (YES if up) at the executable ask seen at
//     jump + latency; value it at the YES/NO mid markoutMs later and at settlement;
//     subtract the taker fee. A latency passes only if the mean P&L 95% CI is > 0.
// Sample gate added 2026-11-12, before any further data (only the 13-event first run had
// been seen): a verdict needs >= MIN_EVENTS usable jump events from >= MIN_MARKETS markets.
// btcSource 'cf' (official CF BRTI from lean captures) is a SECONDARY run; the primary
// verdict stays on the composite feed defined above.

const { compositePrice } = require('./reference-price');
const { estimateTakerFeeDollars } = require('./kalshi-economics');
const { bootstrapMean } = require('./historical-eval');

const MIN_EVENTS = 200, MIN_MARKETS = 50;
const DEFAULTS = Object.freeze({
  jumpUsd: 20, jumpWindowMs: 2000, cooldownMs: 10000, responseMoveCents: 1,
  maxResponseMs: 15000, latenciesMs: [0, 500, 1000, 2000], markoutMs: 30000,
  minTimeLeftMs: 60000, xcorrLags: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
});

const iso = v => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

// Parse capture rows into time series.
function buildSeries(events, { btcSource = 'composite' } = {}) {
  const btc = [], quotes = new Map(), markets = new Map(), latest = {};
  const invalid = new Set();
  for (const e of events) {
    const t = e.received_at_ms, p = e.payload || {};
    if (!Number.isFinite(t)) continue;
    if (btcSource === 'cf' && e.type === 'cf_index' && p.value > 0 && (!p.index_id || p.index_id === 'BRTI')) {
      btc.push({ t, price: p.value });
    } else if (btcSource !== 'cf' && e.type === 'usd_reference_quote' && p.venue && p.mid > 0) {
      latest[p.venue] = { mid: p.mid, ts: t };
      const c = compositePrice(latest, t);
      if (c) btc.push({ t, price: c.price });
    } else if (e.type === 'market_metadata' && p.ticker) {
      const m = markets.get(p.ticker) || {};
      markets.set(p.ticker, { ...m, ticker: p.ticker, openTime: iso(p.open_time) ?? m.openTime, closeTime: iso(p.close_time) ?? m.closeTime, floorStrike: Number(p.floor_strike) || m.floorStrike });
    } else if (e.type === 'market_settlement' && p.ticker) {
      const m = markets.get(p.ticker) || { ticker: p.ticker };
      const r = String(p.result || '').toLowerCase();
      markets.set(p.ticker, { ...m, result: r === 'yes' ? 1 : r === 'no' ? 0 : m.result });
    } else if (e.type === 'sequence_gap' && p.ticker) {
      invalid.add(p.ticker);
    } else if (e.type === 'kalshi_ws' && p.type === 'orderbook_snapshot') {
      const tk = p.msg?.market_ticker; if (tk) invalid.delete(tk);
    } else if (e.type === 'derived_quote' && p.ticker && !invalid.has(p.ticker)) {
      const q = p.quotes || {};
      const yb = q.yesBid?.price, ya = q.yesAsk?.price;
      if (!(yb > 0 && ya > 0 && ya < 1 && ya >= yb)) continue;
      if (!quotes.has(p.ticker)) quotes.set(p.ticker, []);
      quotes.get(p.ticker).push({ t, yesBid: yb, yesAsk: ya, yesAskQty: q.yesAsk?.quantity ?? null, noAsk: q.noAsk?.price ?? 1 - yb, noAskQty: q.noAsk?.quantity ?? null, mid: (yb + ya) / 2 });
    }
  }
  btc.sort((a, b) => a.t - b.t);
  for (const qs of quotes.values()) qs.sort((a, b) => a.t - b.t);
  return { btc, quotes, markets };
}

// Last element with t <= time (binary search), or null.
function at(series, time) {
  let lo = 0, hi = series.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].t <= time) { ans = series[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function frontMarket(markets, quotes, time, minTimeLeftMs) {
  for (const m of markets.values()) {
    if (Number.isFinite(m.openTime) && Number.isFinite(m.closeTime) && m.openTime <= time && time <= m.closeTime - minTimeLeftMs && quotes.has(m.ticker)) return m;
  }
  return null;
}

function findJumps(btc, { jumpUsd, jumpWindowMs, cooldownMs }) {
  const jumps = [];
  let j = 0, lastEvent = -Infinity;
  for (let i = 0; i < btc.length; i++) {
    while (btc[j].t < btc[i].t - jumpWindowMs) j++;
    let lo = btc[j], hi = btc[j];
    for (let k = j; k <= i; k++) { if (btc[k].price < lo.price) lo = btc[k]; if (btc[k].price > hi.price) hi = btc[k]; }
    const up = btc[i].price - lo.price, down = hi.price - btc[i].price;
    if (btc[i].t - lastEvent < cooldownMs) continue;
    if (up >= jumpUsd && lo.t < btc[i].t) { jumps.push({ t: btc[i].t, startT: lo.t, dir: 1, moveUsd: up }); lastEvent = btc[i].t; }
    else if (down >= jumpUsd && hi.t < btc[i].t) { jumps.push({ t: btc[i].t, startT: hi.t, dir: -1, moveUsd: -down }); lastEvent = btc[i].t; }
  }
  return jumps;
}

function percentile(xs, q) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; }

function analyze(events, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { btc, quotes, markets } = buildSeries(events, { btcSource: o.btcSource });
  const jumps = findJumps(btc, o);
  const rows = [];
  for (const j of jumps) {
    const m = frontMarket(markets, quotes, j.t, o.minTimeLeftMs);
    if (!m) continue;
    const qs = quotes.get(m.ticker);
    const before = at(qs, j.startT);
    if (!before || j.t - before.t > 30000) continue;
    // Response: first quote after the move start whose mid moved >= responseMoveCents in the jump direction.
    let responseMs = null;
    for (const q of qs) {
      if (q.t <= j.startT) continue;
      if (q.t - j.t > o.maxResponseMs) break;
      if ((q.mid - before.mid) * j.dir * 100 >= o.responseMoveCents) { responseMs = q.t - j.t; break; }
    }
    // Markouts: buy the jump side at the ask visible at jump + latency.
    const trades = o.latenciesMs.map(L => {
      const q = at(qs, j.t + L), later = at(qs, j.t + L + o.markoutMs);
      if (!q || !later || later.t <= q.t - 1) return { latencyMs: L, ok: false };
      const ask = j.dir > 0 ? q.yesAsk : q.noAsk;
      if (!(ask > 0 && ask < 1)) return { latencyMs: L, ok: false };
      const fee = estimateTakerFeeDollars(ask, 1, 0.07, 1);
      const sideMidLater = j.dir > 0 ? later.mid : 1 - later.mid;
      const settle = Number.isFinite(m.result) ? (j.dir > 0 ? m.result : 1 - m.result) : null;
      return { latencyMs: L, ok: true, ask, fee, markoutPnl: sideMidLater - ask - fee, settlePnl: settle == null ? null : settle - ask - fee };
    });
    rows.push({ ticker: m.ticker, t: j.t, dir: j.dir, moveUsd: j.moveUsd, midBefore: before.mid, responseMs, trades });
  }

  const resp = rows.map(r => r.responseMs).filter(x => x != null);
  const responded = rows.filter(r => r.responseMs != null);
  const summary = {
    rules: o,
    coverage: { btcSamples: btc.length, kalshiQuotes: [...quotes.values()].reduce((a, q) => a + q.length, 0), markets: markets.size, jumps: jumps.length, usableEvents: rows.length },
    response: {
      events: rows.length,
      respondedWithin: rows.length ? { ms0: responded.filter(r => r.responseMs <= 0).length / rows.length, ms1000: responded.filter(r => r.responseMs <= 1000).length / rows.length, ms2000: responded.filter(r => r.responseMs <= 2000).length / rows.length, ms5000: responded.filter(r => r.responseMs <= 5000).length / rows.length } : null,
      noResponseWithinMax: rows.length - responded.length,
      medianMs: percentile(resp, 0.5), p25Ms: percentile(resp, 0.25), p75Ms: percentile(resp, 0.75),
    },
    markout: o.latenciesMs.map(L => {
      const ts = rows.map(r => r.trades.find(x => x.latencyMs === L)).filter(x => x && x.ok);
      const settled = ts.filter(x => x.settlePnl != null);
      const mk = bootstrapMean(ts.map(x => x.markoutPnl)), st = bootstrapMean(settled.map(x => x.settlePnl));
      return { latencyMs: L, trades: ts.length, markoutPnl: mk, settledTrades: settled.length, settlePnl: st, passes: !!(mk && mk.lo > 0) };
    }),
    crossCorrelation: crossCorrelation(btc, quotes, markets, o),
    events: rows,
  };
  const evMarkets = new Set(rows.map(r => r.ticker)).size;
  summary.gate = { minEvents: MIN_EVENTS, minMarkets: MIN_MARKETS, events: rows.length, markets: evMarkets };
  summary.status = rows.length < MIN_EVENTS || evMarkets < MIN_MARKETS ? 'INSUFFICIENT_DATA'
    : summary.markout.some(m => m.passes) ? 'LAG_EDGE_FOUND' : 'NO_LAG_EDGE';
  summary.btcSource = o.btcSource || 'composite';
  return summary;
}

// Correlation of 1s composite BTC changes with Kalshi YES-mid changes k seconds later.
// A peak at k > 0 means Kalshi follows BTC by about k seconds.
function crossCorrelation(btc, quotes, markets, o) {
  if (!btc.length) return [];
  const t0 = Math.ceil(btc[0].t / 1000) * 1000, t1 = btc[btc.length - 1].t;
  const bins = [];
  for (let t = t0; t <= t1; t += 1000) {
    const m = frontMarket(markets, quotes, t, 0);
    const b = at(btc, t), q = m ? at(quotes.get(m.ticker), t) : null;
    bins.push(b && q && t - q.t < 30000 ? { ticker: m.ticker, btc: b.price, mid: q.mid } : null);
  }
  const d = (i, key) => (bins[i] && bins[i - 1] && bins[i].ticker === bins[i - 1].ticker ? bins[i][key] - bins[i - 1][key] : null);
  return o.xcorrLags.map(k => {
    const xs = [], ys = [];
    for (let i = Math.max(1, 1 - k); i < bins.length - Math.max(0, k); i++) {
      const x = d(i, 'btc'), y = d(i + k, 'mid');
      if (x != null && y != null && bins[i].ticker === bins[i + k].ticker) { xs.push(x); ys.push(y); }
    }
    return { lagSec: k, n: xs.length, corr: pearson(xs, ys) };
  });
}

function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

module.exports = { MIN_EVENTS, MIN_MARKETS, DEFAULTS, buildSeries, findJumps, analyze, crossCorrelation, at, pearson };
