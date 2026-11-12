const test = require('node:test');
const assert = require('node:assert/strict');
const supabase = require('../lib/supabase');
const mlPipeline = require('../lib/ml-pipeline');
const MLSignalScorer = require('../agents/skills/analysis/ml-signal-scorer');

test('scorer initialize does not wait for training; trainingInProgress gates until done', async () => {
  const old = { enabled: supabase.enabled, init: supabase.initialize, train: mlPipeline.train };
  let release;
  supabase.initialize = () => {}; supabase.enabled = true;
  mlPipeline.train = () => new Promise(r => { release = r; });
  const oldLog = console.log; console.log = () => {};
  try {
    const s = new MLSignalScorer();
    const t0 = Date.now();
    await s.initialize({ config: {}, registry: { get: () => null } });
    assert.ok(Date.now() - t0 < 500, 'initialize returned before training finished');
    assert.equal(mlPipeline.trainingInProgress, true);
    await new Promise(r => setImmediate(r));
    release();
    await s.trainingPromise;
    assert.equal(mlPipeline.trainingInProgress, false);
  } finally {
    console.log = oldLog; supabase.enabled = old.enabled; supabase.initialize = old.init; mlPipeline.train = old.train;
  }
});

test('a failed background training clears the flag and does not throw', async () => {
  const old = { enabled: supabase.enabled, init: supabase.initialize, train: mlPipeline.train };
  supabase.initialize = () => {}; supabase.enabled = true;
  mlPipeline.train = async () => { throw new Error('network down'); };
  const oldLog = console.log; console.log = () => {};
  try {
    const s = new MLSignalScorer();
    await s.initialize({ config: {}, registry: { get: () => null } });
    await s.trainingPromise;
    assert.equal(mlPipeline.trainingInProgress, false);
  } finally {
    console.log = oldLog; supabase.enabled = old.enabled; supabase.initialize = old.init; mlPipeline.train = old.train;
  }
});
