'use strict';
// Latency telemetry (diagnostic only; never affects trading).
// Answers "is my laptop/network slowing the bot down?" with rolling percentiles:
//   kalshi_refresh_ms  - round trip of each Kalshi market refresh (REST)
//   scan_gap_ms        - time between scan starts (target 2000 ms)
//   scan_ms            - time one scan-and-trade cycle takes
//   btc_age_ms         - age of the Binance BTC price when a decision is made
//   reference_age_ms   - age of the composite USD price when a decision is made
//   event_loop_lag_ms  - how late a 250 ms timer fires (laptop/CPU stalls)
// A summary is appended to data/latency.jsonl every minute.
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 10 * 60 * 1000;
const FILE = () => process.env.LATENCY_LOG || path.join(__dirname, '..', 'data', 'latency.jsonl');

class LatencyMonitor {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.samples = new Map(); this.timers = []; this.lastScanStart = null; }

  record(metric, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const t = this.now();
    if (!this.samples.has(metric)) this.samples.set(metric, []);
    const a = this.samples.get(metric);
    a.push([t, ms]);
    while (a.length && a[0][0] < t - WINDOW_MS) a.shift();
  }

  scanStarted() {
    const t = this.now();
    if (this.lastScanStart != null) this.record('scan_gap_ms', t - this.lastScanStart);
    this.lastScanStart = t;
    return t;
  }

  summary() {
    const out = {};
    for (const [m, a] of this.samples) {
      if (!a.length) continue;
      const v = a.map(x => x[1]).sort((x, y) => x - y), q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
      out[m] = { n: v.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(v[v.length - 1]) };
    }
    return out;
  }

  start() {
    if (this.timers.length) return;
    let expected = this.now() + 250;
    this.timers.push(setInterval(() => { const t = this.now(); this.record('event_loop_lag_ms', Math.max(0, t - expected)); expected = t + 250; }, 250));
    this.timers.push(setInterval(() => this.flush(), 60000));
    this.timers.forEach(t => t.unref?.());
  }

  flush() {
    if (process.env.NODE_TEST_CONTEXT && !process.env.LATENCY_LOG) return;
    try {
      const s = this.summary();
      if (!Object.keys(s).length) return;
      fs.mkdirSync(path.dirname(FILE()), { recursive: true });
      fs.appendFileSync(FILE(), JSON.stringify({ ts: new Date(this.now()).toISOString(), ...s }) + '\n');
    } catch (err) { console.error('[Latency] flush failed:', err.message); }
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }
}

const monitor = new LatencyMonitor();
module.exports = { LatencyMonitor, monitor };
