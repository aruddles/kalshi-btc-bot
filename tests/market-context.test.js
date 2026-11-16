'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const mc = require('../lib/market-context');
const quiet = { log() {}, warn() {} };

test('bookStats: mid, spread and top-N imbalance from array or object levels', () => {
  const s = mc.bookStats([['100', '3'], ['99', '1']], [{ price: '102', size: '1' }, { price: '103', size: '1' }]);
  assert.equal(s.mid, 101);
  assert.equal(s.imb1, 0.5);               // (3-1)/(3+1)
  assert.equal(s.imb10, 0.3333);           // (4-2)/(4+2)
  assert.ok(Math.abs(s.sp_bps - 198.02) < 0.01);
  assert.equal(mc.bookStats([], [['1', '1']]), null);
  assert.equal(mc.bookStats([['102', '1']], [['101', '1']]), null); // crossed book rejected
});

test('Coinbase trades: side is the maker side, so "sell" means the taker bought', () => {
  const t = mc.parseCoinbaseTrades([{ trade_id: 1, time: '2026-11-16T00:00:01.000Z', price: '68000', size: '0.5', side: 'sell' }, { trade_id: 2, time: '2026-11-16T00:00:02.000Z', price: '68000', size: '0.2', side: 'buy' }]);
  assert.deepEqual(t.map(x => x.buy), [true, false]);
  assert.deepEqual(mc.parseCoinbaseBook({ pricebook: { bids: [{ price: '10', size: '1' }], asks: [{ price: '11', size: '1' }] } }).mid, 10.5);
});

test('Kraken book and trades parse from the pair-keyed result', () => {
  const book = mc.parseKrakenBook({ error: [], result: { XXBTZUSD: { bids: [['68000.0', '2', 1]], asks: [['68001.0', '1', 1]] } } });
  assert.equal(book.imb1, 0.3333);
  const t = mc.parseKrakenTrades({ result: { XXBTZUSD: [['68000.1', '0.3', 1794700000.5, 'b', 'm', '', 77], ['68000.0', '0.1', 1794700001, 's', 'l', '', 78]], last: '1' } });
  assert.deepEqual(t.map(x => [x.id, x.buy, x.q]), [[77, true, 0.3], [78, false, 0.1]]);
  assert.equal(t[0].t, 1794700000500);
});

test('TradeWindow: de-duplicates and reports signed flow per window', () => {
  const w = new mc.TradeWindow();
  const now = 1_000_000;
  const trades = [{ id: 'a', t: now - 2000, q: 1, buy: true }, { id: 'b', t: now - 20000, q: 2, buy: false }, { id: 'c', t: now - 50000, q: 4, buy: true }];
  w.add(trades); w.add(trades);
  const s = w.stats(now);
  assert.deepEqual([s.f5, s.f30, s.f60], [1, -1, 3]);
  assert.deepEqual([s.v60, s.n60], [7, 3]);
});

test('Deribit ticker and DVOL parsers', () => {
  const p = mc.parseDeribitTicker({ result: { funding_8h: 0.0001, current_funding: 0.00002, open_interest: 9e8, mark_price: 68034, index_price: 68000, timestamp: 5 } });
  assert.equal(p.basis_bps, 5);
  assert.equal(p.oi_usd, 9e8);
  assert.equal(mc.parseDeribitTicker({ result: {} }), null);
  assert.deepEqual(mc.parseDvol({ result: { data: [[1, 50, 51, 49, 50.5], [2, 50.5, 52, 50, 51.7]] } }), { dvol: 51.7, t: 2 });
  assert.equal(mc.parseDvol({ result: { data: [] } }), null);
});

test('Kalshi book depth and trade tape', () => {
  // YES bids at 40c (10) and 30c (5); NO bids at 55c (20) -> YES ask 45c, and 40c (7) -> YES ask 60c.
  const s = mc.kalshiBookStats({ orderbook_fp: { yes_dollars: [['0.4000', '10.00'], ['0.3000', '5.00']], no_dollars: [['0.5500', '20.00'], ['0.4000', '7.00']] } });
  assert.equal(s.yb, 0.4); assert.equal(s.ya, 0.45);
  assert.deepEqual([s.yb_near, s.yb_total, s.ya_near, s.ya_total], [10, 15, 20, 27]);
  assert.equal(mc.kalshiBookStats({ nope: 1 }), null);
  const t = mc.parseKalshiTrades({ trades: [{ trade_id: 'x', created_time: '2026-11-16T00:00:00Z', yes_price_dollars: '0.4200', count_fp: '3.00', taker_outcome_side: 'no' }] });
  assert.deepEqual([t[0].buy, t[0].q, t[0].p], [false, 3, 0.42]);
});

test('Feed swallows errors, counts failures and recovers', async () => {
  let fail = true;
  const f = new mc.Feed('x', 1000, async () => { if (fail) { const e = new Error('nope'); e.response = { status: 401 }; throw e; } }, quiet);
  assert.equal(await f.poll(), false);
  assert.equal(f.lastError, 'HTTP 401');
  fail = false;
  assert.equal(await f.poll(), true);
  assert.equal(f.failures, 0);
});

test('MarketContext: a Kalshi 401 never touches the trading client; snapshot assembles pieces', async () => {
  let guardHalted = false, signedPaths = [];
  const client = { baseUrl: 'https://k', generateAuth: (m, p) => { signedPaths.push(p); return { headers: { sig: 1 } }; }, get() { guardHalted = true; }, guard: { halt() { guardHalted = true; } } };
  const now = Date.now();
  const http = { get: async (url, opts) => {
    if (url.includes('/orderbook')) { const e = new Error('unauth'); e.response = { status: 401 }; throw e; }
    if (url.includes('/markets/trades')) return { data: { trades: [{ trade_id: 't1', created_time: new Date(now - 1000).toISOString(), yes_price_dollars: '0.5', count_fp: '4.00', taker_outcome_side: 'yes' }] } };
    if (url.includes('product_book')) return { data: { pricebook: { bids: [{ price: '68000', size: '1' }], asks: [{ price: '68001', size: '3' }] } } };
    if (url.includes('coinbase.com/products')) return { data: [{ trade_id: 9, time: new Date(now - 1000).toISOString(), price: '68000', size: '0.25', side: 'sell' }] };
    if (url.includes('/ticker')) return { data: { result: { funding_8h: 1e-4, current_funding: 0, open_interest: 1, mark_price: 68010, index_price: 68000, timestamp: now } } };
    if (url.includes('volatility_index')) return { data: { result: { data: [[now, 1, 1, 1, 47.2]] } } };
    throw new Error('offline');                       // Kraken down
  } };
  const ctx = new mc.MarketContext({ client, http, log: quiet });
  ctx.track('KX-1', now + 600000);
  const ok = await Promise.all(ctx.feeds.map(f => f.poll()));
  const byName = Object.fromEntries(ctx.feeds.map((f, i) => [f.name, ok[i]]));
  assert.equal(byName['kalshi-book'], false);
  assert.equal(byName['kraken-book'], false);
  assert.equal(byName['coinbase-book'], true);
  assert.equal(guardHalted, false);
  assert.deepEqual(signedPaths, ['/trade-api/v2/markets/KX-1/orderbook']);
  const s = ctx.snapshot('KX-1', Date.now());
  assert.equal(s.cb.imb1, -0.5);
  assert.equal(s.cb.f5, 0.25);
  assert.equal(s.kr, null);
  assert.equal(s.dvol, 47.2);
  assert.equal(s.perp.basis_bps, 1.471);
  assert.equal(s.kb, null);
  assert.equal(s.kt.f60, 4);
  assert.equal(ctx.snapshot('KX-1', Date.now() + 10 * 60000).cb, null);   // stale -> null
});

test('append writes one JSON line (only when a test log path is set)', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')), 'ctx.jsonl');
  process.env.MARKET_CONTEXT_LOG = f;
  try {
    mc.append({ ts: 'a', ticker: 'T' });
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8').trim()), { ts: 'a', ticker: 'T' });
  } finally { delete process.env.MARKET_CONTEXT_LOG; }
});
