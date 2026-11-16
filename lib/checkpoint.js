'use strict';
// One-command checkpoint report: the main bot's record split the ways that matter,
// plus the current state of every registered test that can run from local files.
// Read-only. It runs each registered test exactly as registered (no new thresholds);
// tests that have not reached their sample sizes report counts only.
const { bootstrap } = require('./final-precision-oos');
const { ORDERBOOK_FILLS_SINCE } = require('./fill-audit');

const SLOW_GAP_MS = 3000, NEAR_MS = 180000, ITER = 4000, SEED = 20261116;
const cost = t => t.cost ?? t.totalCost;

function cleanTrades(trades) {
  const seen = new Set();
  return trades.filter(t => t && t.orderId && !seen.has(t.orderId) && seen.add(t.orderId) && Number.isFinite(t.pnl) && Number.isFinite(t.entryTime) && t.ticker && cost(t) > 0);
}

// speed: 'slow' if the nearest latency row (within 3 min, n >= 30) shows scans more than
// 3 s apart, 'normal' if it shows 3 s or less, null if there is no timing for that moment.
function speedTagger(latencyRows) {
  const rows = latencyRows.map(r => ({ t: Date.parse(r.ts), gap: r?.scan_gap_ms?.p50, n: r?.event_loop_lag_ms?.n || 0 }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.gap) && r.n >= 30).sort((a, b) => a.t - b.t);
  return t => {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t < t) lo = m + 1; else hi = m; }
    let best = null;
    for (const j of [lo - 1, lo]) if (j >= 0 && j < rows.length && (!best || Math.abs(rows[j].t - t) < Math.abs(best.t - t))) best = rows[j];
    return !best || Math.abs(best.t - t) > NEAR_MS ? null : (best.gap > SLOW_GAP_MS ? 'slow' : 'normal');
  };
}

// Trades, P&L, win rate, and a market-clustered 95% CI for the mean P&L per trade.
function segment(rows) {
  const n = rows.length;
  if (!n) return { trades: 0, markets: 0, pnl: 0, perTrade: null, winRate: null, ci: null, verdict: 'NO_TRADES' };
  const mean = a => a.reduce((s, r) => s + r.pnl, 0) / a.length;
  const ci = bootstrap(rows, a => (a.length ? mean(a) : null), ITER, SEED);
  const verdict = !ci ? 'TOO_FEW_MARKETS' : ci.low > 0 ? 'PROFITABLE_BEYOND_LUCK' : ci.high < 0 ? 'LOSING_BEYOND_LUCK' : 'NOT_DISTINGUISHABLE_FROM_ZERO';
  return { trades: n, markets: new Set(rows.map(r => r.ticker)).size, pnl: rows.reduce((s, r) => s + r.pnl, 0), perTrade: mean(rows),
    winRate: rows.filter(r => r.pnl > 0).length / n, ci: ci ? { low: ci.low, high: ci.high } : null, verdict };
}

function mainBotReport(trades, latencyRows = [], { cutover = Date.parse(ORDERBOOK_FILLS_SINCE) } = {}) {
  const rows = cleanTrades(trades), speed = speedTagger(latencyRows);
  for (const r of rows) { r._speed = speed(r.entryTime); r._book = r.entryTime >= cutover; }
  const old = rows.filter(r => !r._book);
  return {
    cutover: new Date(cutover).toISOString(),
    allLogged: segment(rows),
    summaryFills: segment(old),                                    // before the fill fix (flattered entries)
    summaryFillsNormalSpeed: segment(old.filter(r => r._speed === 'normal')),
    summaryFillsSlow: segment(old.filter(r => r._speed === 'slow')),
    orderBookFills: segment(rows.filter(r => r._book)),            // the honest record
  };
}

// How the lagging market summary compared with the order book at each pre-trade check.
function fillAuditReport(auditRows) {
  const rows = auditRows.filter(r => Number.isFinite(r.bookAsk) && Number.isFinite(r.summaryAsk));
  const gaps = rows.map(r => (r.bookAsk - r.summaryAsk) * 100).sort((a, b) => a - b);
  const q = p => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null);
  return { checks: auditRows.length, compared: rows.length, noBook: auditRows.filter(r => !Number.isFinite(r.bookAsk)).length,
    medianGapCents: q(0.5), p90GapCents: q(0.9), shareBookWorseBy3c: rows.length ? rows.filter(r => r.bookAsk - r.summaryAsk >= 0.03 - 1e-9).length / rows.length : null };
}

module.exports = { SLOW_GAP_MS, cleanTrades, speedTagger, segment, mainBotReport, fillAuditReport };
