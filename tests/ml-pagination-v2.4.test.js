const test = require('node:test');
const assert = require('node:assert/strict');
const supabase = require('../lib/supabase');

// Keyset mock: rows have ids; .gt('id', x).limit(n) returns the next page, capped at 1,000 like PostgREST.
function keysetClient(all, calls, { failFirst = null } = {}) {
  return {
    from(table) {
      assert.equal(table, 'ml_features');
      let lastId = 0, n = 1000;
      const q = {
        select() { return q; }, eq() { return q; }, not() { return q; }, order() { return q; },
        gt(col, v) { assert.equal(col, 'id'); lastId = v; return q; },
        limit(k) { n = k; return q; },
        then(res, rej) {
          calls.push([lastId, n]);
          if (failFirst && failFirst.count-- > 0) return Promise.resolve({ data: null, error: { message: failFirst.message } }).then(res, rej);
          return Promise.resolve({ data: all.filter(r => r.id > lastId).slice(0, Math.min(n, 1000)), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

async function withClient(client, fn) {
  const oldEnabled = supabase.enabled, oldClient = supabase.client;
  supabase.enabled = true; supabase.client = client;
  try { return await fn(); } finally { supabase.enabled = oldEnabled; supabase.client = oldClient; }
}

const mkRows = len => Array.from({ length: len }, (_, i) => ({
  id: i + 1, ticker: `T${Math.floor(i / 25)}`,
  // ids are not in ts order (out-of-order inserts) — result must still be ts-sorted
  ts: new Date(1700000000000 + (i % 2 ? i : i + 0.5) * 1000).toISOString(),
  features: [i], label: i % 2, settled_result: i % 2 ? 'yes' : 'no',
}));

test('getTrainingData keyset-paginates past the 1000-row cap and returns ts order without ids', async () => {
  const calls = [];
  const rows = await withClient(keysetClient(mkRows(2507), calls), () => supabase.getTrainingData());
  assert.equal(rows.length, 2507);
  assert.deepEqual(calls, [[0, 1000], [1000, 1000], [2000, 1000]]);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].ts <= r.ts));
  assert.ok(rows.every(r => !('id' in r)));
});

test('getTrainingData explicit cap still paginates and honors cap', async () => {
  const rows = await withClient(keysetClient(mkRows(3000), []), () => supabase.getTrainingData(1500));
  assert.equal(rows.length, 1500);
});

test('getTrainingData retries statement timeouts, and returns [] (not a partial set) on persistent error', async () => {
  const calls = [];
  const ok = await withClient(keysetClient(mkRows(1200), calls, { failFirst: { count: 1, message: 'canceling statement due to statement timeout' } }),
    () => supabase.getTrainingData(null, { retries: 1 }));
  assert.equal(ok.length, 1200);
  const bad = await withClient(keysetClient(mkRows(1200), [], { failFirst: { count: 99, message: 'canceling statement due to statement timeout' } }),
    () => supabase.getTrainingData(null, { retries: 1 }));
  assert.deepEqual(bad, []);
});

test('ML describe exposes dashboard dataset and validation telemetry', () => {
  const ml = require('../lib/ml-pipeline');
  const d = ml.describe();
  for (const key of ['datasetMarkets','datasetSnapshots','datasetYesMarkets','datasetNoMarkets','trainingMarkets','validationMarkets','validationAccuracy','validationMarketAccuracy','validationBrier','trainingStatus']) {
    assert.ok(Object.prototype.hasOwnProperty.call(d, key), `missing ${key}`);
  }
});
