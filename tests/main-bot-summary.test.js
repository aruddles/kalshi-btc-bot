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

test('break-even uses whole-run averages from gross totals, not the last-100 window', () => {
  const { summarize } = require('../lib/main-bot-summary');
  // Real numbers at 797 trades: last-100 averages said 0.371 / -1.245 (break-even 77%).
  const st = { totalTrades: 797, wins: 644, losses: 153, totalPnL: -15.75, grossWins: 312.44, grossLosses: 328.64,
    avgWinningTrade: 0.371, avgLosingTrade: -1.245, startTime: Date.parse('2026-11-10T10:41:09Z') };
  const out = summarize({ stats: st });
  assert.ok(Math.abs(out.luck.breakevenWinRate - 0.8157) < 0.001, String(out.luck.breakevenWinRate));
  assert.ok(out.luck.winRate < out.luck.breakevenWinRate);
  assert.ok(out.luck.luckChance > 0.5);
});

test('exit-vs-hold summary is cached until the log file changes', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ehc-')), 'exit.jsonl');
  const row = i => JSON.stringify({ orderId: `o${i}`, ticker: `T${i % 50}`, pnl: 0.5, holdPnl: i % 3 ? 1 : -2, delta: 0.5 - (i % 3 ? 1 : -2) }) + '\n';
  fs.writeFileSync(f, Array.from({ length: 320 }, (_, i) => row(i)).join(''));
  const E = require('../lib/exit-hold-log');
  const a = E.summarizeCached(f), b = E.summarizeCached(f);
  assert.equal(a, b);                                  // same object: no recompute
  assert.equal(a.exits, 320);
  assert.ok(a.ci95);
  assert.deepEqual(a, E.summarize(E.load(f)));         // identical to the uncached result
  fs.appendFileSync(f, row(999));
  const c = E.summarizeCached(f);
  assert.notEqual(c, a);
  assert.equal(c.exits, 321);
});

test('pnlSeries: offsets to the run total, marks the order-book cutover, de-duplicates', () => {
  const t = (i, pnl, entry) => ({ orderId: `o${i}`, pnl, entryTime: entry, settleTime: entry + 60000 });
  const trades = [t(1, 0.5, 1000), t(2, -2.5, 5000), t(3, 0.4, 9000), t(1, 0.5, 1000), { orderId: 'x' }];
  const s = M.pnlSeries(trades, { totalPnl: 10, totalTrades: 13, cutover: 5000 });
  assert.equal(s.unloggedTrades, 10);
  assert.equal(s.points[0].n, 10);
  assert.ok(Math.abs(s.points[0].pnl - 11.6) < 1e-9);         // 10 - (0.5 - 2.5 + 0.4)
  assert.deepEqual(s.points.map(p => p.n), [10, 11, 12, 13]);
  assert.equal(s.points[s.points.length - 1].pnl, 10);
  assert.equal(s.cutoverTrade, 11);
  const many = M.pnlSeries(Array.from({ length: 2000 }, (_, i) => t(i, 0.01, i)), { totalPnl: 20, totalTrades: 2000, maxPoints: 400 });
  assert.ok(many.points.length <= 401);
  assert.equal(many.points[many.points.length - 1].n, 2000);
});

test('markPosition: values an open position at the bid on its own side', () => {
  const m = [{ ticker: 'T', yesBid: 0.6, noBid: 0.38, closeTime: 1000 + 90000 }];
  const yes = M.markPosition({ ticker: 'T', side: 'yes', priceCents: 50, filledContracts: 4, totalCost: 2.1 }, m, 1000);
  assert.equal(yes.bidCents, 60);
  assert.ok(Math.abs(yes.unrealized - 0.3) < 1e-9);           // 4 x 0.60 - 2.10
  assert.equal(yes.closesInSec, 90);
  const no = M.markPosition({ ticker: 'T', side: 'no', priceCents: 45, contracts: 2, totalCost: 0.95 }, m, 1000);
  assert.ok(Math.abs(no.unrealized - (-0.19)) < 1e-9);
  const gone = M.markPosition({ ticker: 'Z', side: 'yes', priceCents: 50, contracts: 1, totalCost: 0.5 }, m, 1000);
  assert.equal(gone.unrealized, null);
});

test('"Better probabilities than Kalshi" reads the market comparison, not the model-vs-model one', () => {
  const settlement = { primary: { status: 'BRTI_BETTER_THAN_GBM', markets: 425, minMarkets: 200 },
    brtiProxy: { markets: 442, brierDiff: { BRTI_minus_KALSHI: { low: 0.0036, high: 0.0114 } } } };
  const c = M.summarize({ stats: { totalTrades: 10 }, settlement }).checks.find(x => x.name === 'Better probabilities than Kalshi');
  assert.equal(c.state, 'fail');
  assert.match(c.detail, /Kalshi is more accurate/);
  assert.equal(M.summarize({ stats: {} }).checks.find(x => x.name === 'Better probabilities than Kalshi').state, 'pending');
});
