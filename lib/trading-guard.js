'use strict';

const fs = require('fs');

/**
 * TradingGuard — the single place that decides whether NEW entries may be sent.
 *
 * The Kalshi client consults it on every buy, so it protects every code path
 * (agent skills, legacy engine, scripts), not just the one that remembered to
 * ask. Exits (reduce-only sells) are deliberately not blocked by soft halts: a
 * halted bot should still be able to flatten risk.
 *
 *   halt(reason)              stop new entries until resume() or restart
 *   halt(reason, {hard:true}) same, but resume() refuses (e.g. auth failure)
 *   pause(ms, reason)         stop new entries until the timer expires
 *   kill switch               create the KILL file (default ./data/KILL), or
 *                             set TRADING_ENABLED=false
 */
class TradingGuard {
  constructor({ killFile, enabled, now = Date.now, fsImpl = fs } = {}) {
    this.killFile = killFile || process.env.KILL_SWITCH_FILE || './data/KILL';
    this.enabled = enabled !== undefined ? enabled : process.env.TRADING_ENABLED !== 'false';
    this.now = now;
    this.fs = fsImpl;
    this.halted = false;
    this.hard = false;
    this.reason = null;
    this.haltedAt = null;
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.listeners = [];
  }

  onChange(fn) { this.listeners.push(fn); }

  _notify() {
    for (const fn of this.listeners) {
      try { fn(this.status()); } catch (_) { /* listener errors must never affect trading safety */ }
    }
  }

  halt(reason, { hard = false } = {}) {
    if (!this.halted) this.haltedAt = this.now();
    this.halted = true;
    this.hard = this.hard || hard;
    this.reason = reason;
    this._notify();
  }

  pause(ms, reason) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.pauseReason = reason;
    this._notify();
  }

  resume() {
    if (this.hard) return false;
    this.halted = false;
    this.reason = null;
    this.pausedUntil = 0;
    this.pauseReason = null;
    this._notify();
    return true;
  }

  killSwitchActive() {
    try { return this.fs.existsSync(this.killFile); } catch (_) { return false; }
  }

  /** Reason new entries are blocked right now, or null if they are allowed. */
  blockReason() {
    if (!this.enabled) return 'trading_disabled';
    if (this.killSwitchActive()) return 'kill_switch_file';
    if (this.halted) return `halted:${this.reason}`;
    if (this.pausedUntil > this.now()) return `paused:${this.pauseReason}`;
    return null;
  }

  status() {
    return {
      blocked: this.blockReason(),
      halted: this.halted,
      hard: this.hard,
      reason: this.reason,
      haltedAt: this.haltedAt,
      pausedUntil: this.pausedUntil > this.now() ? this.pausedUntil : null,
      killFile: this.killFile,
    };
  }
}

class TradingBlockedError extends Error {
  constructor(reason) {
    super(`Order blocked by trading guard: ${reason}`);
    this.name = 'TradingBlockedError';
    this.reason = reason;
  }
}

module.exports = { TradingGuard, TradingBlockedError };
