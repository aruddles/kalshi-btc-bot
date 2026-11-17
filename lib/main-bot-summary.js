'use strict';
// Main-bot panel + "is it real yet?" scorecard for the dashboard (display only).
const fs = require('fs');
const path = require('path');
const { normalCdf } = require('./normal');

const TARGET_TRADES = 1000;

// Average win/loss over the WHOLE run, from the cumulative gross totals. (stats.avgWinningTrade /
// avgLosingTrade only cover the last ~100 closed positions kept in state, so mixing them with
// all-time win/loss counts mis-stated break-even: 77% shown vs ~81.6% real at 797 trades.)
// Falls back to the windowed averages only when gross totals are missing.
function runAverages(stats) {
  const wins = Number(stats.wins) || 0, losses = Number(stats.losses) || 0;
  const gw = Number(stats.grossWins), gl = Number(stats.grossLosses);
  if (wins > 0 && losses > 0 && Number.isFinite(gw) && Number.isFinite(gl)) return { w: gw / wins, l: -gl / losses };
  return { w: Number(stats.avgWinningTrade), l: Number(stats.avgLosingTrade) };
}

// Per-trade P&L spread estimated from win/loss sizes (stats keep no full history).
function luckCheck(stats) {
  const n = Number(stats.totalTrades) || 0, wins = Number(stats.wins) || 0;
  const { w, l } = runAverages(stats);
  if (n < 30 || !Number.isFinite(w) || !Number.isFinite(l)) return { ready: false, n };
  const mean = (Number(stats.totalPnL) || 0) / n, p = wins / n;
  const sd = Math.sqrt(p * (w - mean) ** 2 + (1 - p) * (l - mean) ** 2);
  if (!(sd > 0)) return { ready: false, n };
  const z = mean / (sd / Math.sqrt(n));
  return { ready: true, n, meanPerTrade: mean, z, luckChance: 1 - normalCdf(z), breakevenWinRate: -l / (w - l), winRate: p };
}

// An open position valued at the current bid on its side (what selling now would fetch,
// before the exit fee). Display only: uses the bot's own market quotes.
function markPosition(p, markets = [], now = Date.now()) {
  const contracts = Number(p.filledContracts || p.contracts) || 0, cost = Number(p.totalCost) || 0;
  const m = markets.find(x => x.ticker === p.ticker);
  const bid = Number(p.side === 'yes' ? m?.yesBid : m?.noBid);
  const ok = Number.isFinite(bid) && bid >= 0 && contracts > 0;
  const closeTime = Number(p.closeTime) || Number(m?.closeTime) || null;
  return { ticker: p.ticker, side: p.side, entryCents: p.priceCents, contracts, cost,
    bidCents: ok ? Math.round(bid * 100) : null, unrealized: ok ? bid * contracts - cost : null,
    openedAt: p.entryTime || p.createdAt || null, closesInSec: closeTime ? Math.max(0, Math.round((closeTime - now) / 1000)) : null };
}

// Running P&L for the chart: one point per logged trade in close order, offset so the
// last point equals the bot's total (the first trades of the run were never logged one by one).
function pnlSeries(trades, { totalPnl = 0, totalTrades = 0, maxPoints = 400, cutover = null } = {}) {
  const seen = new Set(), rows = [];
  for (const t of trades || []) {
    if (!t || !t.orderId || seen.has(t.orderId) || !Number.isFinite(Number(t.pnl))) continue;
    seen.add(t.orderId); rows.push(t);
  }
  const at = t => Number(t.settleTime || t.closeTime || t.entryTime) || 0;
  rows.sort((a, b) => at(a) - at(b));
  const logged = rows.reduce((s, t) => s + Number(t.pnl), 0);
  const start = Math.max(0, Number(totalTrades) - rows.length);
  let cum = Number(totalPnl) - logged;
  const points = [{ n: start, pnl: cum, t: rows.length ? at(rows[0]) : null }];
  let cutoverN = null;
  rows.forEach((t, i) => {
    cum += Number(t.pnl);
    if (cutover != null && cutoverN == null && Number(t.entryTime) >= cutover) cutoverN = start + i;
    points.push({ n: start + i + 1, pnl: cum, t: at(t) });
  });
  const step = Math.max(1, Math.ceil(points.length / maxPoints));
  const thin = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  return { points: thin.map(p => ({ n: p.n, pnl: Math.round(p.pnl * 100) / 100, t: p.t })), unloggedTrades: start, cutoverTrade: cutoverN };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function summarize({ stats = {}, openPositions = [], closedPositions = [], exitHold = null, settlement = null, markets = [], now = Date.now() } = {}) {
  const luck = luckCheck(stats);
  const n = Number(stats.totalTrades) || 0;
  const checks = [
    { name: 'Enough trades', detail: `${n} / ${TARGET_TRADES}`, state: n >= TARGET_TRADES ? 'pass' : 'pending', progress: Math.min(1, n / TARGET_TRADES) },
    { name: 'Profit beats luck', detail: luck.ready ? `${Math.round(luck.luckChance * 100)}% chance it's luck` : 'need 30+ trades',
      state: !luck.ready ? 'pending' : luck.luckChance < 0.05 ? 'pass' : luck.meanPerTrade < 0 ? 'fail' : 'pending' },
    { name: 'Realistic fills', detail: 'paper buys and sells use the real order book', state: 'pass' },
    exitHold ? { name: 'Sell early vs hold', detail: exitHold.status === 'INSUFFICIENT_DATA' ? `${exitHold.exits} / ${exitHold.minExits} early sells` : exitHold.status.replace(/_/g, ' ').toLowerCase(),
      state: exitHold.status === 'INSUFFICIENT_DATA' ? 'pending' : 'info', progress: Math.min(1, exitHold.exits / exitHold.minExits) } : null,
    // The registered settlement test compares our two models; the market comparison is
    // brtiProxy.brierDiff.BRTI_minus_KALSHI (Brier difference CI; > 0 means Kalshi is more accurate).
    (() => { const ci = settlement?.brtiProxy?.brierDiff?.BRTI_minus_KALSHI, n = settlement?.brtiProxy?.markets;
      return { name: 'Better probabilities than Kalshi', detail: ci ? `${ci.low > 0 ? 'no — Kalshi is more accurate' : ci.high < 0 ? 'yes' : 'too close to call'} · ${n ?? '?'} markets` : 'ask Claude to run the settlement test',
        state: !ci ? 'pending' : ci.high < 0 ? 'pass' : ci.low > 0 ? 'fail' : 'pending' }; })(),
  ].filter(Boolean);
  const recent = closedPositions.slice(-8).reverse().map(p => ({
    ticker: p.ticker, side: p.side, entryCents: p.priceCents, contracts: p.originalFilledContracts || p.filledContracts || p.contracts,
    pnl: Number(p.pnl) || 0, exit: p.exitType === 'TAKE_PROFIT' ? 'sold early' : 'settled', at: p.settleTime || null,
  }));
  return {
    trades: n, wins: Number(stats.wins) || 0, losses: Number(stats.losses) || 0, pnl: Number(stats.totalPnL) || 0,
    winRate: n ? (Number(stats.wins) || 0) / n : null, perTrade: n ? (Number(stats.totalPnL) || 0) / n : null,
    since: stats.startTime ? new Date(stats.startTime).toISOString() : null, open: openPositions.length,
    openPositions: openPositions.map(p => markPosition(p, markets, now)),
    luck, checks, recent,
  };
}

function load(state, dataDir = path.join(__dirname, '..', 'data'), markets = state?.activeMarkets || []) {
  let exitHold = null;
  try { const E = require('./exit-hold-log'); exitHold = E.summarizeCached(); } catch { /* optional */ }
  return summarize({ stats: state?.stats, openPositions: state?.openPositions, closedPositions: state?.closedPositions,
    exitHold, settlement: readJson(path.join(dataDir, 'settlement-shadow', 'summary.json')), markets });
}

module.exports = { TARGET_TRADES, luckCheck, summarize, load, markPosition, pnlSeries };
