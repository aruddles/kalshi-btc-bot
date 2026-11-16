'use strict';
// Throttled persistence for the research paper labs (shadow experiments only).
// The labs called save() on every evaluation, rewriting a 1-3 MB state file
// several times per market scan on the main thread. Now:
//   - a new trade, position or settlement is written immediately, as before;
//   - counter-only changes (opportunities, last decision) are written at most
//     once per interval, and flushed on shutdown/restart.
// A crash can lose at most `intervalMs` of those counters, never a trade.
function makeSaver({ write, signature, intervalMs = 10000, now = Date.now }) {
  let lastSig = null, lastWrite = 0, dirty = false, timer = null;
  const writeNow = sig => {
    clearTimeout(timer); timer = null;
    write();
    lastSig = sig; lastWrite = now(); dirty = false;
  };
  return {
    save() {
      const sig = signature();
      if (sig !== lastSig || now() - lastWrite >= intervalMs) return writeNow(sig);
      dirty = true;
      if (!timer) { timer = setTimeout(() => { timer = null; if (dirty) writeNow(signature()); }, Math.max(0, lastWrite + intervalMs - now())); timer.unref?.(); }
    },
    flush() { if (dirty) writeNow(signature()); },
    get pending() { return dirty; },
  };
}

// Changes whenever any book gains a position, a settled trade or a new entered ticker.
function bookSignature(books) {
  let s = '';
  for (const p of Object.values(books || {})) s += `${p.positions?.length || 0}/${p.trades?.length || 0}/${p.entered?.size || 0};`;
  return s;
}

module.exports = { makeSaver, bookSignature };
