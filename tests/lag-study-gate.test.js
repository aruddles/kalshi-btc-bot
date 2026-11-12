const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/lag-study');

function events({ markets = 1, jumpsPerMarket = 3, source = 'composite' } = {}) {
  const ev = []; const t0 = 1_800_000_000_000;
  for (let m = 0; m < markets; m++) {
    const open = t0 + m * 900000, close = open + 900000, tk = 'M' + m;
    ev.push({ type: 'market_metadata', received_at_ms: open, payload: { ticker: tk, open_time: new Date(open).toISOString(), close_time: new Date(close).toISOString(), floor_strike: 80000 } });
    let px = 80000;
    for (let s = 0; s < 840; s++) {
      const t = open + s * 1000;
      if (s % 200 === 100 && s / 200 < jumpsPerMarket) px += 30;
      if (source === 'cf') ev.push({ type: 'cf_index', received_at_ms: t, payload: { index_id: 'BRTI', value: px } });
      else for (const venue of ['coinbase', 'kraken']) ev.push({ type: 'usd_reference_quote', received_at_ms: t, payload: { venue, mid: px } });
      ev.push({ type: 'derived_quote', received_at_ms: t, payload: { ticker: tk, quotes: { yesBid: { price: 0.49 }, yesAsk: { price: 0.51 }, noAsk: { price: 0.51 } } } });
    }
  }
  return ev.sort((a, b) => a.received_at_ms - b.received_at_ms);
}

test('small samples are INSUFFICIENT_DATA regardless of markouts', () => {
  const r = L.analyze(events({ markets: 2 }));
  assert.equal(r.status, 'INSUFFICIENT_DATA');
  assert.equal(r.gate.minEvents, L.MIN_EVENTS);
  assert.equal(r.btcSource, 'composite');
});

test('official CF index can drive the (secondary) BTC series', () => {
  const r = L.analyze(events({ markets: 2, source: 'cf' }), { btcSource: 'cf' });
  assert.ok(r.coverage.btcSamples > 1000);
  assert.ok(r.coverage.jumps >= 2, `jumps=${r.coverage.jumps}`);
  assert.equal(r.btcSource, 'cf');
  const composite = L.analyze(events({ markets: 2, source: 'cf' }));
  assert.equal(composite.coverage.btcSamples, 0, 'primary composite run ignores cf_index rows');
});
