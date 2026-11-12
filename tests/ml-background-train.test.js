const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const B = require('../lib/ml-background-train');

test('training in a worker leaves the main thread responsive and applies state', async () => {
  const pipeline = { trained: false, trees: [], liveShadow: { keep: 1 }, challengers: { status: 'COLLECTING', forwardCalls: { a: 1 } } };
  let ticks = 0; const iv = setInterval(() => ticks++, 50);
  const ok = await B.trainInWorker(pipeline, path.join(__dirname, 'fixtures', 'fake-train-worker.js'));
  clearInterval(iv);
  assert.equal(ok, true);
  assert.ok(ticks >= 15, `main thread ticked ${ticks} times during 1.5s of worker CPU`);
  assert.equal(pipeline.trained, true);
  assert.equal(pipeline.trees.length, 1);
  assert.equal(pipeline.challengers.status, 'READY');
  assert.deepEqual(pipeline.challengers.forwardCalls, { a: 1 }, 'live challenger state kept');
  assert.deepEqual(pipeline.liveShadow, { keep: 1 }, 'live shadow kept');
});

test('worker errors reject without changing the pipeline', async () => {
  const pipeline = { trained: false };
  await assert.rejects(B.trainInWorker(pipeline, path.join(__dirname, 'fixtures', 'failing-train-worker.js')), /network down/);
  assert.equal(pipeline.trained, false);
});

test('exportState never ships live fields or functions', () => {
  const s = B.exportState({ trained: true, liveShadow: { x: 1 }, fn() {}, challengers: { status: 'READY', models: {}, forwardCalls: { y: 1 } } });
  assert.deepEqual(Object.keys(s.pipe), ['trained']);
  assert.deepEqual(Object.keys(s.challengers).sort(), ['models', 'status']);
});
