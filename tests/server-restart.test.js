const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('../lib/server-restart');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));

test('restart is refused in LIVE mode only', () => {
  assert.equal(R.canRestart('live').ok, false);
  assert.equal(R.canRestart('paper').ok, true);
  assert.equal(R.canRestart('paper+').ok, true);
});

test('a running PAPER bot resumes once after restart, and the marker is consumed', () => {
  const d = tmp();
  R.writeMarker(d, { running: true, mode: 'paper' }, 1000);
  assert.equal(R.consumeAutostart(d, 'paper', 2000), true);
  assert.equal(fs.existsSync(R.markerPath(d)), false);
  assert.equal(R.consumeAutostart(d, 'paper', 2000), false);
});

test('no auto-resume when idle, stale, missing, or LIVE', () => {
  const d = tmp();
  assert.equal(R.consumeAutostart(d, 'paper'), false);
  R.writeMarker(d, { running: false, mode: 'paper' }, 1000); assert.equal(R.consumeAutostart(d, 'paper', 2000), false);
  R.writeMarker(d, { running: true, mode: 'paper' }, 0); assert.equal(R.consumeAutostart(d, 'paper', R.MARKER_MAX_AGE_MS + 1), false);
  R.writeMarker(d, { running: true, mode: 'live' }, 1000); assert.equal(R.consumeAutostart(d, 'live', 2000), false);
  R.writeMarker(d, { running: true, mode: 'paper' }, 1000); assert.equal(R.consumeAutostart(d, 'live', 2000), false);
});
