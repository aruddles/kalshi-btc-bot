'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/baymax-entry');

// Deterministic synthetic trades. `bad(i)` marks trades the judge should learn to skip.
function make(n, { t0, signal }) {
  let s = 7; const rnd = () => ((s = (1103515245 * s + 12345) % 2147483648) / 2147483648);
  const out = [];
  for (let i = 0; i < n; i++) {
    const yes = rnd() < 0.5, bearish = rnd() < 0.5, counter = yes ? bearish : !bearish;
    const pWin = signal && counter ? 0.6 : 0.88, won = rnd() < pWin, price = 0.6 + 0.2 * rnd(), costUsd = 2.5;
    const entryTime = t0 + i * 120000, closeTime = entryTime + 400000 + Math.floor(rnd() * 300000);
    out.push({ orderId: `o${t0}-${i}`, ticker: `KX-${t0}-${Math.floor(i / 2)}`, side: yes ? 'yes' : 'no', priceDecimal: price, edge: 4 + 6 * rnd(), modelProb: price + 0.05,
      entryTime, closeTime, settleTime: closeTime - 60000, cost: costUsd, pnl: won ? 0.45 : -costUsd, reason: `x | 1H: ${bearish ? 'BEARISH' : 'BULLISH'}` });
  }
  return out;
}
const REG = Date.parse('2026-11-16T11:00:00Z');

test('features use only information available at entry', () => {
  const tr = make(60, { t0: REG - 60 * 120000, signal: true });
  const { rows } = E.buildRows(tr);
  const first = rows[0], later = rows[40];
  assert.equal(first.f.recent_win20, 0.8);             // no closed history yet: default
  assert.equal(first.f.same_side_pnl10, 0);
  assert.ok(later.f.recent_win20 >= 0 && later.f.recent_win20 <= 1);
  // Changing a later trade's outcome must not change an earlier trade's features.
  const tr2 = tr.map((t, i) => (i === 59 ? { ...t, pnl: -t.cost } : t));
  assert.deepEqual(E.buildRows(tr2).rows[40].f, later.f);
  assert.equal(rows[1].f.stack_index, 1);              // second entry on the same ticker
  assert.equal(E.buildRows([...tr, tr[0], { orderId: 'bad' }]).excluded, 2); // duplicate + malformed
});

test('before the thresholds only counts are reported', () => {
  const res = E.evaluate([...make(400, { t0: REG - 400 * 120000, signal: true }), ...make(100, { t0: REG, signal: true })]);
  assert.equal(res.status, 'INSUFFICIENT_DATA');
  assert.equal(res.counts.test, 100);
  assert.equal(res.ci, undefined);
  assert.equal(res.pnlAll, undefined);
  assert.match(res.fingerprint, /^[0-9a-f]{16}$/);
});

test('finds a real pattern, and finds nothing when there is none', () => {
  const real = E.evaluate([...make(600, { t0: REG - 600 * 120000, signal: true }), ...make(700, { t0: REG, signal: true })]);
  assert.equal(real.status, 'JUDGE_WORKS');
  assert.ok(real.weights.trend_align > 0);             // with-trend trades predicted better
  assert.ok(real.pnlTakeOnly > real.pnlAll);
  const none = E.evaluate([...make(600, { t0: REG - 600 * 120000, signal: false }), ...make(700, { t0: REG, signal: false })]);
  assert.equal(none.status, 'NO_EVIDENCE');
});

test('the frozen model ignores forward trades', () => {
  const train = make(400, { t0: REG - 400 * 120000, signal: true });
  const a = E.evaluate([...train, ...make(50, { t0: REG, signal: true })]);
  const b = E.evaluate([...train, ...make(350, { t0: REG, signal: false })]);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.threshold, b.threshold);
});
