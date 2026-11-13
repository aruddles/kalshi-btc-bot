const test = require('node:test');
const assert = require('node:assert/strict');
const { isQuiet, isWeekend, evaluate } = require('../lib/quiet-hours');

test('quiet = weekends + weekday 8 PM-8 AM New York time (DST-aware)', () => {
  assert.equal(isQuiet(Date.parse('2026-11-12T19:00:00Z')), false); // Thu 2 PM EST
  assert.equal(isQuiet(Date.parse('2026-11-13T01:30:00Z')), true);  // Thu 8:30 PM EST
  assert.equal(isQuiet(Date.parse('2026-11-12T13:00:00Z')), false); // Thu 8:00 AM EST
  assert.equal(isQuiet(Date.parse('2026-11-12T12:30:00Z')), true);   // Thu 7:30 AM EST
  assert.equal(isQuiet(Date.parse('2026-11-14T17:00:00Z')), true);   // Sat noon
  assert.equal(isWeekend(Date.parse('2026-11-15T04:00:00Z')), true);  // Sat 11 PM ET
  assert.equal(isQuiet(Date.parse('2026-07-15T23:30:00Z')), false);  // Wed 7:30 PM EDT
  assert.equal(isQuiet(Date.parse('2026-07-16T00:30:00Z')), true);   // Wed 8:30 PM EDT
});

test('evaluate: insufficient until thresholds, then a clear difference is detected', () => {
  const mk = (n, quietStart, r) => Array.from({ length: n }, (_, i) => ({
    ticker: `T${quietStart}-${Math.floor(i / 3)}`, entryTime: quietStart + i * 60e3, cost: 2.5, pnl: 2.5 * (r + ((i % 3) - 1) * 0.01),
  }));
  const busyStart = Date.parse('2026-11-11T16:00:00Z');   // Wed 11 AM ET
  const quietStart = Date.parse('2026-11-14T15:00:00Z');  // Sat 10 AM ET
  const small = evaluate([...mk(30, busyStart, 0.01), ...mk(30, quietStart, 0.05)], { iterations: 200 });
  assert.equal(small.status, 'INSUFFICIENT_DATA');
  assert.ok(small.diff > 0.03);
  const big = evaluate([...mk(180, busyStart, 0.01), ...mk(180, quietStart, 0.05)], { iterations: 300 });
  assert.equal(big.quiet.trades, 180);
  assert.equal(big.weekendTrades, 180);
  assert.equal(big.status, 'QUIET_BETTER');
});
