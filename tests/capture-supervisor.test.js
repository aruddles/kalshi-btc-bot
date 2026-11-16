'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const EventEmitter = require('events');
const { CaptureSupervisor } = require('../lib/capture-supervisor');
const quiet = { log() {}, warn() {} };

function harness() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  let t = 1_000_000_000_000; const spawned = [], timers = [];
  const spawn = (cmd, args, opts) => { const c = new EventEmitter(); c.pid = undefined; c.killed = null; c.kill = sig => { c.killed = sig; }; c.args = args; c.env = opts.env; spawned.push(c); return c; };
  const sup = new CaptureSupervisor({ rootDir, spawn, now: () => t, log: quiet, setTimer: fn => { timers.push(fn); return {}; } });
  return { sup, spawned, timers, rootDir, tick: ms => { t += ms; } };
}

test('start launches a lean, time-limited capture and remembers the request', () => {
  const h = harness();
  const s = h.sup.start(14);
  assert.equal(s.running, true);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0].args, ['scripts/capture-kalshi-history.js']);
  assert.equal(h.spawned[0].env.CAPTURE_LEAN, 'true');
  assert.equal(h.spawned[0].env.CAPTURE_DURATION_MINUTES, '360');     // 6-hour chunks
  assert.ok(fs.existsSync(path.join(h.rootDir, 'data', '.lag-capture.json')));
  assert.throws(() => h.sup.start(0));
  assert.throws(() => h.sup.start(500));
});

test('a finished chunk is followed by the next one until the hours run out', () => {
  const h = harness();
  h.sup.start(7);
  h.tick(6 * 3600000); h.spawned[0].emit('exit', 0);
  assert.equal(h.timers.length, 1);
  h.timers[0]();
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1].env.CAPTURE_DURATION_MINUTES, '60');      // only the remainder
  h.tick(3600000); h.spawned[1].emit('exit', 0);
  assert.equal(h.sup.status().running, false);
  assert.equal(h.sup.status().until, null);
  assert.ok(!fs.existsSync(path.join(h.rootDir, 'data', '.lag-capture.json')));
});

test('a capture that keeps dying immediately is abandoned, not respawned forever', () => {
  const h = harness();
  h.sup.start(10);
  for (let i = 0; i < 5; i++) { h.tick(1000); h.spawned[h.spawned.length - 1].emit('exit', 2); if (h.timers[i]) h.timers[i](); }
  assert.equal(h.spawned.length, 5);
  assert.equal(h.sup.status().running, false);
  assert.equal(h.sup.status().until, null);
});

test('bot shutdown stops the child but keeps the request; resume restarts it; stop ends it', () => {
  const h = harness();
  h.sup.start(10);
  h.sup.stop({ keep: true });
  assert.equal(h.spawned[0].killed, 'SIGTERM');
  h.spawned[0].emit('exit', 0);                                        // must not respawn itself
  assert.equal(h.timers.length, 0);
  const again = new CaptureSupervisor({ rootDir: h.rootDir, spawn: (c, a, o) => { const e = new EventEmitter(); e.kill = () => {}; e.env = o.env; h.spawned.push(e); return e; }, now: () => 1_000_000_000_000 + 3600000, log: quiet });
  assert.equal(again.resume().running, true);
  assert.equal(h.spawned[1].env.CAPTURE_DURATION_MINUTES, '360');
  again.stop();
  assert.ok(!fs.existsSync(path.join(h.rootDir, 'data', '.lag-capture.json')));
  assert.equal(new CaptureSupervisor({ rootDir: h.rootDir, spawn: () => { throw new Error('must not spawn'); }, log: quiet }).resume().running, false);
});
