const test = require('node:test');
const assert = require('node:assert/strict');
const { LatencyMonitor } = require('../lib/latency-monitor');

test('rolling percentiles, scan gaps, and window expiry', () => {
  let t = 1_000_000;
  const m = new LatencyMonitor({ now: () => t });
  for (let i = 1; i <= 100; i++) m.record('kalshi_refresh_ms', i);
  m.scanStarted(); t += 2000; m.scanStarted(); t += 2600; m.scanStarted();
  const s = m.summary();
  assert.equal(s.kalshi_refresh_ms.n, 100);
  assert.equal(s.kalshi_refresh_ms.p50, 51);
  assert.equal(s.kalshi_refresh_ms.p95, 96);
  assert.equal(s.kalshi_refresh_ms.max, 100);
  assert.deepEqual([s.scan_gap_ms.n, s.scan_gap_ms.max], [2, 2600]);
  t += 11 * 60 * 1000; m.record('kalshi_refresh_ms', 5);
  assert.equal(m.summary().kalshi_refresh_ms.n, 1);
  m.record('x', NaN); m.record('x', -1);
  assert.equal(m.summary().x, undefined);
});

test('flush is a no-op under node --test unless pointed at a temp file', () => {
  const m = new LatencyMonitor(); m.record('a', 1);
  assert.doesNotThrow(() => m.flush());
});
