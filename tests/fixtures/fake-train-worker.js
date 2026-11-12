// Test worker: burns CPU like real training, then posts plain model state.
const { parentPort } = require('worker_threads');
const t = Date.now(); let x = 0; while (Date.now() - t < 1500) x += Math.sqrt(x + 1);
parentPort.postMessage({ ok: true, pipe: { trained: true, trees: [{ feature: 1, threshold: 0, leftPred: 0, rightPred: 1, weight: 0.1 }], modelVersion: 'fake', liveShadow: undefined },
  challengers: { status: 'READY', models: { FINAL: { status: 'READY' } } } });
