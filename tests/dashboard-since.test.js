const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dashboard-since');

const mk = () => ({ startingCash: 100, cash: 0, realizedPnl: -3, fees: 9, maxDrawdown: .5, positions: [{ totalCost: 2 }],
  trades: [
    { settledAt: '2026-11-09T00:00:00Z', realizedPnl: -5, estimatedFee: 1 },
    { settledAt: '2026-11-11T00:00:00Z', realizedPnl: 3, estimatedFee: .5 },
    { settledAt: '2026-11-11T01:00:00Z', realizedPnl: -1, estimatedFee: .25 },
  ] });

test('sinceMs: default cutoff, override, and all', () => {
  assert.equal(D.sinceMs({}), Date.parse(D.DEFAULT_SINCE));
  assert.equal(D.sinceMs({ DASHBOARD_SINCE: 'all' }), null);
  assert.equal(D.sinceMs({ DASHBOARD_SINCE: '2026-11-11T00:00:00Z' }), Date.parse('2026-11-11T00:00:00Z'));
});

test('viewSince drops pre-cutoff trades and recomputes totals without mutating', () => {
  const p = mk(), v = D.viewSince(p, Date.parse('2026-11-10T00:00:00Z'));
  assert.equal(v.trades.length, 2);
  assert.equal(v.realizedPnl, 2);
  assert.equal(v.cash, 100 + 2 - 2);
  assert.equal(v.fees, .75);
  assert.ok(Math.abs(v.maxDrawdown - 1 / 103) < 1e-12);
  assert.equal(p.trades.length, 3); assert.equal(p.realizedPnl, -3);
});

test('snapshotSince runs the lab snapshot on the filtered view only', () => {
  const lab = { portfolios: { A: mk() }, snapshot() { const p = this.portfolios.A; return { n: p.trades.length, pnl: p.realizedPnl }; } };
  const s = D.snapshotSince(lab, 'portfolios', [], { DASHBOARD_SINCE: '2026-11-10T00:00:00Z' });
  assert.deepEqual([s.n, s.pnl], [2, 2]);
  assert.ok(s.displaySince);
  assert.equal(lab.portfolios.A.trades.length, 3);
  assert.deepEqual(D.snapshotSince(lab, 'portfolios', [], { DASHBOARD_SINCE: 'all' }), { n: 3, pnl: -3 });
});
