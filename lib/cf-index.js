'use strict';
// Official CF Benchmarks BRTI (the index KXBTC15M settles on), via Kalshi's
// authenticated REST passthrough: GET /trade-api/v2/cfbenchmarks/values?id=BRTI.
// Shadow data only. Uses its own request and error handling on purpose: the main
// Kalshi client hard-halts trading on any 401, and a data feed must never do that.
const axios = require('axios');

const PATH = '/trade-api/v2/cfbenchmarks/values';
const WINDOW_MS = 60000;

// Find the newest {value, time} pair in whatever shape the upstream returns.
function parseLatest(body) {
  let best = null;
  const visit = (o, depth) => {
    if (!o || depth > 6) return;
    if (Array.isArray(o)) { for (const x of o) visit(x, depth + 1); return; }
    if (typeof o !== 'object') return;
    const v = Number(o.value ?? o.value_usd ?? o.price), t = Number(o.time ?? o.timestamp ?? o.source_ts_ms);
    if (Number.isFinite(v) && v > 1000 && Number.isFinite(t) && t > 1e12 && (!best || t > best.time)) best = { value: v, time: t };
    for (const k of Object.keys(o)) if (typeof o[k] === 'object') visit(o[k], depth + 1);
  };
  visit(body, 0);
  return best;
}

class CfIndexPoller {
  constructor({ client, intervalMs = 5000, id = 'BRTI', http = axios, log = console } = {}) {
    Object.assign(this, { client, intervalMs, id, http, log });
    this.samples = [];          // [{ value, time }]
    this.failures = 0;
    this.lastError = null;
    this.timer = null;
  }

  async poll() {
    try {
      const { headers } = this.client.generateAuth('GET', PATH);
      const res = await this.http.get(`${this.client.baseUrl}${PATH}`, { headers, params: { id: this.id }, timeout: 6000 });
      const s = parseLatest(res.data);
      if (!s) throw new Error('no value in response');
      const last = this.samples[this.samples.length - 1];
      if (!last || s.time > last.time) this.samples.push(s);
      const cutoff = s.time - 3 * WINDOW_MS;
      while (this.samples.length && this.samples[0].time < cutoff) this.samples.shift();
      if (this.failures) this.log.log(`[CFIndex] ${this.id} feed recovered`);
      this.failures = 0; this.lastError = null;
      return s;
    } catch (err) {
      this.failures++;
      this.lastError = err?.response?.status ? `HTTP ${err.response.status}` : err.message;
      if (this.failures === 1 || this.failures % 60 === 0) this.log.warn(`[CFIndex] ${this.id} fetch failed (${this.lastError}); will keep retrying, trading unaffected`);
      return null;
    }
  }

  start() {
    if (this.timer || !this.client?.generateAuth) return;
    const tick = async () => {
      await this.poll();
      // Back off to once a minute after repeated failures.
      this.timer = setTimeout(tick, this.failures >= 3 ? 60000 : this.intervalMs);
      this.timer.unref?.();
    };
    tick();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  // Latest value plus our own trailing-60s average of the samples we hold.
  snapshot(now = Date.now()) {
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.time > 30000) return { value: null, time: null, avg60: null, avg60Samples: 0, error: this.lastError };
    const win = this.samples.filter(s => s.time > last.time - WINDOW_MS);
    return { value: last.value, time: last.time, avg60: win.reduce((a, s) => a + s.value, 0) / win.length, avg60Samples: win.length, error: null };
  }
}

module.exports = { PATH, parseLatest, CfIndexPoller };
