'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { makeSaver, bookSignature } = require('../lib/lab-save');
const { ModelArena } = require('../lib/model-arena');

test('makeSaver: material changes write at once, counter-only changes are throttled', () => {
  let writes = 0, sig = 'a', t = 1000;
  const s = makeSaver({ write: () => writes++, signature: () => sig, intervalMs: 10000, now: () => t });
  s.save(); assert.equal(writes, 1);            // first save always writes
  s.save(); s.save(); assert.equal(writes, 1);  // nothing material changed: deferred
  assert.equal(s.pending, true);
  sig = 'b'; s.save(); assert.equal(writes, 2); // new trade/position: immediate
  assert.equal(s.pending, false);
  s.save(); t += 10000; s.save(); assert.equal(writes, 3); // interval elapsed
  s.save(); s.flush(); assert.equal(writes, 4);            // shutdown flush
  s.flush(); assert.equal(writes, 4);                      // nothing pending
});

test('bookSignature changes with positions, trades and entered tickers', () => {
  const b = { A: { positions: [], trades: [], entered: new Set() } };
  const s0 = bookSignature(b);
  b.A.entered.add('T'); const s1 = bookSignature(b);
  b.A.positions.push({}); const s2 = bookSignature(b);
  b.A.trades.push({}); const s3 = bookSignature(b);
  assert.equal(new Set([s0, s1, s2, s3]).size, 4);
});

test('ModelArena: an entry is on disk immediately; later no-trade counters wait for flush', () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-')), 'state.json');
  const arena = new ModelArena({ enabled: true, statePath, minEdge: 0.05 });
  const onDisk = () => JSON.parse(fs.readFileSync(statePath, 'utf8')).portfolios.EARLY_CHAMPION;
  const market = { ticker: 'KX-1', yesAsk: 0.40, noAsk: 0.62, yesAskSize: 50, noAskSize: 50, closeTime: Date.now() + 600000 };
  const d = arena.evaluate('EARLY_CHAMPION', market, 0.80);
  assert.equal(d.side, 'yes');
  assert.equal(onDisk().positions.length, 1);                 // trade persisted at once
  const before = onDisk().opportunities;
  arena.evaluate('EARLY_CHAMPION', market, 0.80);             // position already open: counter only
  assert.equal(onDisk().opportunities, before);               // not rewritten yet
  arena.flush();
  assert.equal(onDisk().opportunities, before + 1);
  const closed = arena.settle('KX-1', 'yes');
  assert.equal(closed.length, 1);
  assert.equal(onDisk().trades.length, 1);                    // settlement persisted at once
});
