const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/main-bot-summary');

const stats = { totalTrades: 272, wins: 228, losses: 44, totalPnL: 19.23, avgWinningTrade: 0.54, avgLosingTrade: -2.37, startTime: Date.parse('2026-11-10T10:41:09Z') };

test('luck check: modest positive record is not yet beyond luck', () => {
  const l = M.luckCheck(stats);
  assert.equal(l.ready, true);
  assert.ok(l.luckChance > 0.05 && l.luckChance < 0.5, String(l.luckChance));
  assert.ok(Math.abs(l.breakevenWinRate - 2.37 / 2.91) < 1e-9);
  assert.equal(M.luckCheck({ totalTrades: 5 }).ready, false);
});

test('summary shapes panel data and scorecard', () => {
  const s = M.summarize({ stats, openPositions: [{ ticker: 'T', side: 'no', priceCents: 64, filledContracts: 4 }],
    closedPositions: [{ ticker: 'KXBTC15M-A', side: 'yes', priceCents: 57, filledContracts: 4, pnl: -2.99, exitType: 'SETTLEMENT' },
                      { ticker: 'KXBTC15M-B', side: 'no', priceCents: 34, filledContracts: 5, pnl: 0.33, exitType: 'TAKE_PROFIT' }],
    exitHold: { status: 'INSUFFICIENT_DATA', exits: 11, minExits: 300 } });
  assert.equal(s.trades, 272); assert.equal(s.open, 1);
  assert.equal(s.recent[0].exit, 'sold early');
  const names = s.checks.map(c => c.name);
  assert.deepEqual(names, ['Enough trades', 'Profit beats luck', 'Realistic fills', 'Sell early vs hold', 'Better probabilities than Kalshi']);
  assert.equal(s.checks[0].state, 'pending');
  assert.equal(s.checks[1].state, 'pending');
  assert.equal(s.checks[3].detail, '11 / 300 early sells');
});
