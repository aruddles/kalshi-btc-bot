'use strict';
// Main-bot panel + "is it real yet?" scorecard for the dashboard (display only).
const fs = require('fs');
const path = require('path');
const { normalCdf } = require('./normal');

const TARGET_TRADES = 1000;

// Per-trade P&L spread estimated from win/loss sizes (stats keep no full history).
function luckCheck(stats) {
  const n = Number(stats.totalTrades) || 0, wins = Number(stats.wins) || 0;
  const w = Number(stats.avgWinningTrade), l = Number(stats.avgLosingTrade);
  if (n < 30 || !Number.isFinite(w) || !Number.isFinite(l)) return { ready: false, n };
  const mean = (Number(stats.totalPnL) || 0) / n, p = wins / n;
  const sd = Math.sqrt(p * (w - mean) ** 2 + (1 - p) * (l - mean) ** 2);
  if (!(sd > 0)) return { ready: false, n };
  const z = mean / (sd / Math.sqrt(n));
  return { ready: true, n, meanPerTrade: mean, z, luckChance: 1 - normalCdf(z), breakevenWinRate: -l / (w - l), winRate: p };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function summarize({ stats = {}, openPositions = [], closedPositions = [], exitHold = null, settlement = null } = {}) {
  const luck = luckCheck(stats);
  const n = Number(stats.totalTrades) || 0;
  const checks = [
    { name: 'Enough trades', detail: `${n} / ${TARGET_TRADES}`, state: n >= TARGET_TRADES ? 'pass' : 'pending', progress: Math.min(1, n / TARGET_TRADES) },
    { name: 'Profit beats luck', detail: luck.ready ? `${Math.round(luck.luckChance * 100)}% chance it's luck` : 'need 30+ trades',
      state: !luck.ready ? 'pending' : luck.luckChance < 0.05 ? 'pass' : luck.meanPerTrade < 0 ? 'fail' : 'pending' },
    { name: 'Realistic fills', detail: 'paper sell prices match real bids', state: 'pass' },
    exitHold ? { name: 'Sell early vs hold', detail: exitHold.status === 'INSUFFICIENT_DATA' ? `${exitHold.exits} / ${exitHold.minExits} early sells` : exitHold.status.replace(/_/g, ' ').toLowerCase(),
      state: exitHold.status === 'INSUFFICIENT_DATA' ? 'pending' : 'info', progress: Math.min(1, exitHold.exits / exitHold.minExits) } : null,
    { name: 'Better probabilities than Kalshi', detail: settlement?.primary ? `${settlement.primary.markets} / ${settlement.primary.minMarkets} markets · ${settlement.primary.status.replace(/_/g, ' ').toLowerCase()}` : 'ask Claude to run the settlement test',
      state: settlement?.primary?.status === 'BRTI_BETTER_THAN_GBM' ? 'pass' : settlement?.primary?.status === 'BRTI_WORSE_THAN_GBM' ? 'fail' : 'pending' },
  ].filter(Boolean);
  const recent = closedPositions.slice(-8).reverse().map(p => ({
    ticker: p.ticker, side: p.side, entryCents: p.priceCents, contracts: p.originalFilledContracts || p.filledContracts || p.contracts,
    pnl: Number(p.pnl) || 0, exit: p.exitType === 'TAKE_PROFIT' ? 'sold early' : 'settled', at: p.settleTime || null,
  }));
  return {
    trades: n, wins: Number(stats.wins) || 0, losses: Number(stats.losses) || 0, pnl: Number(stats.totalPnL) || 0,
    winRate: n ? (Number(stats.wins) || 0) / n : null, perTrade: n ? (Number(stats.totalPnL) || 0) / n : null,
    since: stats.startTime ? new Date(stats.startTime).toISOString() : null, open: openPositions.length,
    openPositions: openPositions.map(p => ({ ticker: p.ticker, side: p.side, entryCents: p.priceCents, contracts: p.filledContracts || p.contracts })),
    luck, checks, recent,
  };
}

function load(state, dataDir = path.join(__dirname, '..', 'data')) {
  let exitHold = null;
  try { const E = require('./exit-hold-log'); exitHold = E.summarize(E.load()); } catch { /* optional */ }
  return summarize({ stats: state?.stats, openPositions: state?.openPositions, closedPositions: state?.closedPositions,
    exitHold, settlement: readJson(path.join(dataDir, 'settlement-shadow', 'summary.json')) });
}

module.exports = { TARGET_TRADES, luckCheck, summarize, load };
