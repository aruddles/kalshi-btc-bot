'use strict';
// Display-only "since" filter for the research (ML) paper-lab dashboard panels.
// Stored portfolio history is never modified; snapshots are computed on a
// filtered view. The main bot does not use this (its record is since v3.1).
// Default cutoff = research reset 2026-11-13 10:05Z: pre-v3.1 snapshots were deleted
// and the ML models retrained on Grade-A (v3.1) markets only, so research scores
// restart from there. Previous cutoff (v3.1 start) was 2026-11-10T10:41:09Z.
// Override with DASHBOARD_SINCE=<ISO time>, or DASHBOARD_SINCE=all to show everything.
const DEFAULT_SINCE = '2026-11-13T10:05:00Z';

function sinceMs(env = process.env) {
  const raw = String(env.DASHBOARD_SINCE ?? DEFAULT_SINCE).trim();
  if (!raw || raw.toLowerCase() === 'all') return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function tradeTime(t) {
  for (const v of [t?.settledAt, t?.timestamp]) {
    const n = typeof v === 'number' ? v : Date.parse(v || '');
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Portfolio copy containing only trades settled at/after `since`, with
// realized P&L, cash, fees and drawdown recomputed from those trades.
function viewSince(p, since) {
  if (!p || since == null) return p;
  const trades = (p.trades || []).filter(t => { const ts = tradeTime(t); return ts != null && ts >= since; })
    .sort((a, b) => tradeTime(a) - tradeTime(b));
  const realizedPnl = trades.reduce((s, t) => s + (Number(t.realizedPnl) || 0), 0);
  const start = Number(p.startingCash) || 0;
  const openCost = (p.positions || []).reduce((s, x) => s + (Number(x.totalCost) || 0), 0);
  let eq = start, peak = start, maxDrawdown = 0;
  for (const t of trades) { eq += Number(t.realizedPnl) || 0; peak = Math.max(peak, eq); maxDrawdown = Math.max(maxDrawdown, peak ? (peak - eq) / peak : 0); }
  const view = { ...p, trades, realizedPnl, cash: start + realizedPnl - openCost, maxEquity: peak, maxDrawdown };
  if ('fees' in p) view.fees = trades.reduce((s, t) => s + (Number(t.estimatedFee) || 0), 0);
  if (Array.isArray(p.noTrades)) view.noTrades = p.noTrades.filter(t => { const ts = tradeTime(t); return ts == null || ts >= since; });
  return view;
}

// Run lab.snapshot() against filtered views without touching the lab's state.
// `key` is the lab property holding its portfolios ('portfolios' or 'policies').
function snapshotSince(lab, key, markets, env = process.env) {
  if (!lab) return null;
  const since = sinceMs(env);
  if (since == null || !lab[key]) return lab.snapshot(markets);
  const view = Object.create(lab);
  view[key] = Object.fromEntries(Object.entries(lab[key]).map(([id, p]) => [id, viewSince(p, since)]));
  const snap = lab.snapshot.call(view, markets);
  return snap && typeof snap === 'object' ? { ...snap, displaySince: new Date(since).toISOString() } : snap;
}

module.exports = { DEFAULT_SINCE, sinceMs, tradeTime, viewSince, snapshotSince };
