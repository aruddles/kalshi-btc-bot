const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/baymax-exit');
const T = require('../lib/trend-filter');

function rng(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }

// Synthetic exits with a known answer. edge = how far the market bid sits below the true win
// probability (0 = fair market -> holding should not beat selling).
function synth(n, edge, seed) {
  const r = rng(seed), exits = [], snaps = new Map(), t0 = Date.parse('2026-11-14T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const ticker = `KXBTC15M-T${Math.floor(i / 3)}`, side = r() < 0.5 ? 'yes' : 'no';
    const p = 0.6 + 0.38 * r(), win = r() < p, bid = Math.max(0.02, Math.min(0.97, p - edge));
    const contracts = 5, cost = 2.5, exitTime = t0 + i * 60e3;
    const fee = Math.ceil(0.07 * contracts * bid * (1 - bid) * 100 - 1e-10) / 100;
    exits.push({ ticker, side, exitTime, contracts, cost, pnl: contracts * bid - fee - cost, holdPnl: (win ? contracts : 0) - cost, result: win ? side : (side === 'yes' ? 'no' : 'yes') });
    const yb = side === 'yes' ? bid : 1 - (bid + 0.01), ya = yb + 0.01, strike = 70000;
    const sideDist = (p - 0.5) * 40, px = strike * (1 + (side === 'yes' ? sideDist : -sideDist) / 1e4);
    const meta = { kalshi_yes_bid: yb, kalshi_yes_ask: ya, brti_p: side === 'yes' ? p : 1 - p, time_remaining_s: 300, floor_strike: strike, cf_brti: px, settlement_strike: null };
    if (!snaps.has(ticker)) snaps.set(ticker, []);
    snaps.get(ticker).push({ ts: new Date(exitTime - 5000).toISOString(), collector_meta: meta });
  }
  return { exits, snaps };
}

test('snapshotAt: latest at/before exit within 15 s; NO-side features are flipped', () => {
  const ex = Date.parse('2026-11-14T00:10:00Z');
  const snaps = [{ ts: '2026-11-14T00:09:40Z', collector_meta: {} }, { ts: '2026-11-14T00:09:50Z', collector_meta: { a: 1 } }, { ts: '2026-11-14T00:10:05Z', collector_meta: {} }];
  assert.deepEqual(B.snapshotAt(snaps, ex).collector_meta, { a: 1 });
  assert.equal(B.snapshotAt([{ ts: '2026-11-14T00:09:40Z', collector_meta: {} }], ex), null);
  const meta = { kalshi_yes_bid: 0.30, kalshi_yes_ask: 0.32, brti_p: 0.25, time_remaining_s: 450, floor_strike: 70000, cf_brti: 69930, settlement_strike: null };
  const f = B.features({ side: 'no' }, meta);
  assert.ok(Math.abs(f.side_bid - 0.68) < 1e-9 && Math.abs(f.side_brti_p - 0.75) < 1e-9 && Math.abs(f.side_mid - 0.69) < 1e-9);
  assert.ok(Math.abs(f.side_dist_bps - 10) < 1e-9 && f.time_frac === 0.5);
  assert.equal(B.features({ side: 'yes' }, { ...meta, brti_p: null }), null);
  assert.ok(B.features({ side: 'yes' }, { ...meta, cf_brti: null, reference_price: 70010 })); // fallback
});

test('logistic fit recovers the direction of a known relationship', () => {
  const r = rng(7), X = [], y = [];
  for (let i = 0; i < 2000; i++) { const a = r() * 4 - 2, b = r() * 4 - 2; X.push([a, b]); y.push(r() < 1 / (1 + Math.exp(-(1.5 * a - 0.8 * b))) ? 1 : 0); }
  const m = B.fitLogistic(X, y);
  assert.ok(m.w[1] > 1.0 && m.w[1] < 2.0 && m.w[2] < -0.4 && m.w[2] > -1.2, `weights ${m.w}`);
});

test('counts only (no outcomes) until 600 eligible exits', () => {
  const { exits, snaps } = synth(300, 0.06, 1);
  const res = B.evaluate(B.buildRows(exits, snaps));
  assert.equal(res.status, 'INSUFFICIENT_DATA');
  assert.equal(res.coverage.eligible, 300);
  assert.equal(res.arms, undefined);
});

test('underpriced holds -> rule/ML pass; fair market -> neither passes', () => {
  const good = B.evaluate(B.buildRows(...Object.values(synth(650, 0.08, 2))));
  assert.ok(['RULE_PASSES', 'ML_PASSES'].includes(good.status), good.status);
  assert.ok(good.arms.C_rule.pnl > good.arms.A_always_sell.pnl);
  assert.equal(good.split.train, 400); assert.equal(good.split.test, 200);
  const fair = B.evaluate(B.buildRows(...Object.values(synth(650, 0, 3))));
  assert.equal(fair.status, 'NEITHER_PASSES');
});

test('trend filter: label parsing, registration cutoff, counts-only before threshold, verdict after', () => {
  assert.equal(T.trendLabel('Net EV 13¢ | 1H: BEARISH'), 'BEARISH');
  assert.equal(T.isCounterTrend({ side: 'yes', reason: '1H: BEARISH' }), true);
  assert.equal(T.isCounterTrend({ side: 'no', reason: '1H: BEARISH' }), false);
  const mk = (n, start, side, label, pnl) => Array.from({ length: n }, (_, i) => ({ ticker: `${side}${label}${Math.floor(i / 3)}`, entryTime: start + i * 60e3, side, reason: `x | 1H: ${label}`, cost: 2.5, pnl: pnl + ((i % 3) - 1) * 0.1 }));
  const after = T.REGISTERED_AT + 1000;
  const early = T.evaluate([...mk(200, T.REGISTERED_AT - 1e9, 'yes', 'BEARISH', -1), ...mk(50, after, 'yes', 'BEARISH', -1)]);
  assert.equal(early.status, 'INSUFFICIENT_DATA');
  assert.equal(early.counts.counterTrend, 50); // pre-registration trades excluded
  assert.equal(early.counterMeanReturn, undefined);
  const done = T.evaluate([...mk(180, after, 'yes', 'BEARISH', -1), ...mk(100, after, 'no', 'NEUTRAL', 0.5)]);
  assert.equal(done.status, 'FILTER_HELPS');
  assert.ok(done.pnlWithoutCounterTrend > done.pnlAll);
});
