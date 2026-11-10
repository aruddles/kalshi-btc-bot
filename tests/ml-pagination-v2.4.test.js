const test = require('node:test');
const assert = require('node:assert/strict');
const supabase = require('../lib/supabase');

test('getTrainingData paginates past Supabase 1000-row response cap', async () => {
  const oldEnabled = supabase.enabled;
  const oldClient = supabase.client;
  const all = Array.from({ length: 2507 }, (_, i) => ({
    ticker: `T${Math.floor(i / 25)}`,
    ts: new Date(1700000000000 + i * 1000).toISOString(),
    features: [i], label: i % 2, settled_result: i % 2 ? 'yes' : 'no',
  }));
  const ranges = [];
  supabase.enabled = true;
  supabase.client = {
    from(table) {
      assert.equal(table, 'ml_features');
      const q = {
        select() { return q; }, eq() { return q; }, not() { return q; }, order() { return q; },
        async range(from, to) {
          ranges.push([from, to]);
          return { data: all.slice(from, Math.min(to + 1, from + 1000)), error: null };
        },
      };
      return q;
    },
  };
  try {
    const rows = await supabase.getTrainingData();
    assert.equal(rows.length, 2507);
    assert.deepEqual(ranges, [[0,999],[1000,1999],[2000,2999]]);
    assert.equal(rows[2506].features[0], 2506);
  } finally {
    supabase.enabled = oldEnabled;
    supabase.client = oldClient;
  }
});

test('getTrainingData explicit cap still paginates and honors cap', async () => {
  const oldEnabled = supabase.enabled;
  const oldClient = supabase.client;
  const all = Array.from({ length: 3000 }, (_, i) => ({ ticker: `T${i}`, ts: `${i}`, features: [i], label: 1, settled_result: 'yes' }));
  supabase.enabled = true;
  supabase.client = { from() { const q = { select(){return q},eq(){return q},not(){return q},order(){return q},async range(a,b){return {data:all.slice(a,b+1),error:null}} }; return q; } };
  try { assert.equal((await supabase.getTrainingData(1500)).length, 1500); }
  finally { supabase.enabled = oldEnabled; supabase.client = oldClient; }
});

test('ML describe exposes dashboard dataset and validation telemetry', () => {
  const ml = require('../lib/ml-pipeline');
  const d = ml.describe();
  for (const key of ['datasetMarkets','datasetSnapshots','datasetYesMarkets','datasetNoMarkets','trainingMarkets','validationMarkets','validationAccuracy','validationMarketAccuracy','validationBrier','trainingStatus']) {
    assert.ok(Object.prototype.hasOwnProperty.call(d, key), `missing ${key}`);
  }
});
