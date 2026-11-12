const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLatest, CfIndexPoller, PATH } = require('../lib/cf-index');

const client = { baseUrl: 'https://x', generateAuth: (m, p) => ({ headers: { sig: m + p } }) };
const quiet = { log() {}, warn() {} };

test('parseLatest finds the newest value in wrapped CF payloads', () => {
  assert.deepEqual(parseLatest({ data: { payload: [{ value: '80000.5', time: 1794470000000 }, { value: '80001.25', time: 1794470001000 }] } }), { value: 80001.25, time: 1794470001000 });
  assert.equal(parseLatest({ data: {} }), null);
});

test('poller signs the bare path, keeps samples, and averages the trailing 60s', async () => {
  let t = 1794470000000, calls = [];
  const http = { get: async (url, opts) => { calls.push([url, opts]); t += 5000; return { data: { data: { payload: [{ value: String(80000 + (t % 100000) / 1000), time: t }] } } }; } };
  const p = new CfIndexPoller({ client, http, log: quiet });
  for (let i = 0; i < 20; i++) await p.poll();
  assert.equal(calls[0][0], 'https://x' + PATH);
  assert.equal(calls[0][1].headers.sig, 'GET' + PATH);
  assert.deepEqual(calls[0][1].params, { id: 'BRTI' });
  const s = p.snapshot(t);
  assert.equal(s.avg60Samples, 12);
  assert.ok(Number.isFinite(s.avg60) && s.value >= 80000);
});

test('errors (incl. 401) are contained: no throw, no halt, snapshot goes empty', async () => {
  const http = { get: async () => { const e = new Error('unauth'); e.response = { status: 401 }; throw e; } };
  const p = new CfIndexPoller({ client, http, log: quiet });
  assert.equal(await p.poll(), null);
  assert.equal(p.failures, 1);
  const s = p.snapshot();
  assert.equal(s.value, null); assert.equal(s.error, 'HTTP 401');
});

test('stale values are not reported as current', async () => {
  const http = { get: async () => ({ data: { payload: [{ value: '80000', time: 1794470000000 }] } }) };
  const p = new CfIndexPoller({ client, http, log: quiet });
  await p.poll();
  assert.equal(p.snapshot(1794470000000 + 31000).value, null);
});
