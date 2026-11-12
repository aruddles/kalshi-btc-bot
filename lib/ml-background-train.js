'use strict';
// Run ML training in a worker thread (v3.9.1).
// mlPipeline.train() is mostly synchronous math; on the main thread it froze the
// whole bot (collector, trading, dashboard) for ~10 minutes after every restart.
// The worker trains its own copy and posts back plain model state, which is
// applied to the main-thread pipeline in one synchronous step.
const path = require('path');
const { Worker } = require('worker_threads');

// Fields that hold live, main-thread state and must never be overwritten.
const LIVE_FIELDS = new Set(['challengers', 'liveShadow']);
const CHALLENGER_FIELDS = ['status', 'models', 'dataset'];

function exportState(pipeline) {
  const pipe = {};
  for (const [k, v] of Object.entries(pipeline)) if (!LIVE_FIELDS.has(k) && typeof v !== 'function') pipe[k] = v;
  const ch = pipeline.challengers || {};
  return { pipe, challengers: Object.fromEntries(CHALLENGER_FIELDS.filter(k => k in ch).map(k => [k, ch[k]])) };
}

function applyState(pipeline, msg) {
  for (const [k, v] of Object.entries(msg.pipe || {})) if (!LIVE_FIELDS.has(k)) pipeline[k] = v;
  if (pipeline.challengers && msg.challengers) Object.assign(pipeline.challengers, msg.challengers);
}

function trainInWorker(pipeline, file = process.env.ML_TRAIN_WORKER_FILE || path.join(__dirname, 'ml-train-worker.js')) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const w = new Worker(file);
    w.once('message', msg => {
      if (msg && msg.error) return done(reject, new Error(msg.error));
      try { applyState(pipeline, msg || {}); } catch (err) { return done(reject, err); }
      done(resolve, !!(msg && msg.ok));
      w.terminate();
    });
    w.once('error', err => done(reject, err));
    w.once('exit', code => done(reject, new Error(`training worker exited (${code}) without a result`)));
  });
}

module.exports = { exportState, applyState, trainInWorker };
