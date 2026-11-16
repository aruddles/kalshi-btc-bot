'use strict';
// Runs the lean market-data capture (scripts/capture-kalshi-history.js) as a separate,
// low-priority child process for a fixed number of hours, so the millisecond lead-lag
// study (lib/lag-study.js, rules fixed 2026-11-11/12) can collect its sample.
// Data only: the capture never places, changes or cancels orders, and because it is its
// own process with its own Kalshi client, nothing it does can halt or slow the trader's
// event loop. The request survives bot restarts via a small marker file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

const CHUNK_MINUTES = 360, RESPAWN_MS = 5000, QUICK_EXIT_MS = 30000, MAX_QUICK_EXITS = 5;

class CaptureSupervisor {
  constructor({ rootDir = path.join(__dirname, '..'), spawn = realSpawn, now = Date.now, log = console, setTimer = setTimeout } = {}) {
    Object.assign(this, { rootDir, spawn, now, log, setTimer });
    this.marker = path.join(rootDir, 'data', '.lag-capture.json');
    this.child = null; this.until = 0; this.quickExits = 0; this.startedAt = 0; this.lastExit = null; this.timer = null;
  }

  _readMarker() { try { return Number(JSON.parse(fs.readFileSync(this.marker, 'utf8')).until) || 0; } catch { return 0; } }
  _writeMarker() { try { fs.mkdirSync(path.dirname(this.marker), { recursive: true }); fs.writeFileSync(this.marker, JSON.stringify({ until: this.until })); } catch (_) { /* best effort */ } }
  _clearMarker() { try { fs.unlinkSync(this.marker); } catch (_) { /* already gone */ } }

  /** Resume a capture that was requested before a restart. */
  resume() { const until = this._readMarker(); if (until > this.now()) { this.until = until; this._spawn(); } else if (until) this._clearMarker(); return this.status(); }

  start(hours) {
    const h = Number(hours);
    if (!(h > 0 && h <= 72)) throw new Error('hours must be between 0 and 72');
    this.until = this.now() + h * 3600000; this.quickExits = 0; this._writeMarker();
    if (!this.child) this._spawn();
    return this.status();
  }

  /** stop(): end the capture for good. stop({ keep: true }): just stop the child (bot shutdown). */
  stop({ keep = false } = {}) {
    if (!keep) { this.until = 0; this._clearMarker(); }
    clearTimeout(this.timer); this.timer = null;
    const c = this.child; this.child = null;
    if (c) { try { c.kill('SIGTERM'); } catch (_) { /* already exited */ } }
    return this.status();
  }

  _spawn() {
    const left = this.until - this.now();
    if (left <= 60000) { this.until = 0; this._clearMarker(); return; }
    const minutes = Math.max(1, Math.min(CHUNK_MINUTES, Math.floor(left / 60000)));
    let child;
    try {
      let out = 'ignore';
      try { fs.mkdirSync(path.join(this.rootDir, 'logs'), { recursive: true }); out = fs.openSync(path.join(this.rootDir, 'logs', 'capture.log'), 'a'); } catch (_) { /* no log file */ }
      child = this.spawn(process.execPath, ['scripts/capture-kalshi-history.js'], {
        cwd: this.rootDir, stdio: ['ignore', out, out],
        env: { ...process.env, CAPTURE_LEAN: 'true', CAPTURE_DURATION_MINUTES: String(minutes) },
      });
    } catch (err) { this.lastExit = { error: err.message, at: this.now() }; this.log.warn(`[Capture] could not start: ${err.message}`); return; }
    this.child = child; this.startedAt = this.now();
    try { if (child.pid) os.setPriority(child.pid, 10); } catch (_) { /* priority is a nicety */ }
    this.log.log(`[Capture] lean capture started (pid ${child.pid}, ${minutes} min chunk); shadow data only`);
    const done = (code, why) => {
      if (this.child !== child) return;               // stopped on purpose
      this.child = null;
      const ran = this.now() - this.startedAt;
      this.lastExit = { code, why, ranMs: ran, at: this.now() };
      this.quickExits = ran < QUICK_EXIT_MS ? this.quickExits + 1 : 0;
      if (this.quickExits >= MAX_QUICK_EXITS) { this.log.warn('[Capture] exiting immediately every time; giving up (trading unaffected)'); this.until = 0; this._clearMarker(); return; }
      if (this.until > this.now()) { this.timer = this.setTimer(() => { this.timer = null; if (!this.child && this.until > this.now()) this._spawn(); }, RESPAWN_MS); this.timer?.unref?.(); }
      else { this.until = 0; this._clearMarker(); this.log.log('[Capture] finished'); }
    };
    child.on('exit', code => done(code, 'exit'));
    child.on('error', err => done(null, err.message));
  }

  status() {
    let files = [];
    try { files = fs.readdirSync(path.join(this.rootDir, 'data', 'captures')).filter(f => f.endsWith('-lean.jsonl.gz')); } catch (_) { /* none yet */ }
    return { running: !!this.child, pid: this.child?.pid ?? null, until: this.until ? new Date(this.until).toISOString() : null, leanFiles: files.length, lastExit: this.lastExit };
  }
}

module.exports = { CaptureSupervisor, CHUNK_MINUTES };
