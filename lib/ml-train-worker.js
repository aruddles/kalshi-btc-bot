'use strict';
// Worker-thread entry: trains the ML pipeline off the main thread and posts the
// resulting model state back. See lib/ml-background-train.js.
const { parentPort } = require('worker_threads');
const supabase = require('./supabase');
const pipeline = require('./ml-pipeline');
const { exportState } = require('./ml-background-train');

(async () => {
  try {
    supabase.initialize();
    const ok = await pipeline.train();
    parentPort.postMessage({ ok, ...exportState(pipeline) });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
})();
