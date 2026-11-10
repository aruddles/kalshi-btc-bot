'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// Hermetic: the client must never touch the network in tests, so axios is replaced
// whether or not it is installed.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'axios') return { get() { throw new Error('network disabled in tests'); }, post() { throw new Error('network disabled in tests'); }, delete() { throw new Error('network disabled in tests'); } };
  return originalLoad.call(this, request, ...rest);
};
const KalshiClient = require('../bot/kalshi');
const { TradingGuard } = require('../lib/trading-guard');
Module._load = originalLoad;

const rawMarket = {
  ticker: 'T', status: 'active', open_time: '2026-11-01T21:45:00Z', close_time: '2026-11-01T22:00:00Z',
  yes_bid_dollars: '0.4800', yes_ask_dollars: '0.5200', no_bid_dollars: '0.4800', no_ask_dollars: '0.5200',
  yes_bid_size_fp: '100.00', yes_ask_size_fp: '40.00',
};
const buy = (o = {}) => ({ ticker: 'T', action: 'buy', side: 'yes', count: 3, type: 'limit', time_in_force: 'immediate_or_cancel', yes_price_dollars: '0.5200', client_order_id: 'c', ...o });

function liveClient(extra = {}) {
  const guard = new TradingGuard({ killFile: '/nonexistent', fsImpl: { existsSync: () => false } });
  const c = new KalshiClient({ TRADING_MODE: 'live', KALSHI_API_KEY: 'k', guard, ...extra }, {});
  const calls = [];
  c.post = async (path, body) => { calls.push({ method: 'POST', path, body }); return { data: { order_id: 'live-1', fill_count: '3.00', remaining_count: '0.00', average_fill_price: '0.5200', average_fee_paid: '0.0200' } }; };
  c.get = async (path) => {
    calls.push({ method: 'GET', path });
    if (path.includes('/markets/')) return { data: { market: rawMarket } };
    if (path.includes('/balance')) return { data: { balance: 10000, balance_dollars: '100.0000' } };
    if (path.includes('/positions')) return { data: { market_positions: [{ ticker: 'KXBTC15M-A', position_fp: '-3.00', market_exposure_dollars: '1.2000' }, { ticker: 'OTHER', position_fp: '1.00' }] } };
    if (path.includes('/orders/')) return { data: { order: { order_id: 'live-1', status: 'executed', fill_count_fp: '3.00', taker_fill_cost_dollars: '1.5600', taker_fees_dollars: '0.0600' } } };
    throw new Error(`unexpected GET ${path}`);
  };
  return { c, calls, guard };
}

test('default mode is PAPER and nothing is posted', async () => {
  const c = new KalshiClient({ KALSHI_API_KEY: 'k' }, {});
  assert.equal(c.tradingMode, 'paper');
  assert.ok(c.isPaper);
  c.post = async () => { throw new Error('paper mode must not POST'); };
  c.get = async () => ({ data: { market: rawMarket } });
  const o = await c.placeOrder(buy());
  assert.equal(o.fill_count, 3);
  assert.ok(String(o.order_id).startsWith('paper-'));
  const again = await c.getOrder(o.order_id);
  assert.equal(again.fill_count, 3);
});

test('TRADING_MODE is only live when exactly live; paper+ remains simulated', () => {
  for (const v of ['LIVE', 'live']) assert.equal(new KalshiClient({ TRADING_MODE: v }, {}).tradingMode, 'live');
  const plus = new KalshiClient({ TRADING_MODE: 'paper+', PAPER_BALANCE: 100 }, {});
  assert.equal(plus.tradingMode, 'paper+');
  assert.equal(plus.isPaper, true);
  assert.ok(plus.paper);
  for (const v of ['true', '1', 'prod', '', undefined]) assert.equal(new KalshiClient({ TRADING_MODE: v }, {}).tradingMode, 'paper');
});

test('live buy YES posts a V2 order to /portfolio/events/orders with dollar strings', async () => {
  const { c, calls } = liveClient();
  const o = await c.placeOrder(buy());
  const post = calls.find(x => x.method === 'POST');
  assert.equal(post.path, '/trade-api/v2/portfolio/events/orders');
  assert.deepEqual(post.body, {
    ticker: 'T', side: 'bid', count: '3.00', price: '0.5200',
    time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', subaccount: 0, exchange_index: -1, client_order_id: 'c',
  });
  assert.equal(o.fill_count, 3);
  assert.equal(o.taker_fill_cost, 156);
  assert.equal(o.taker_fees, 6);
});

test('live buy NO is sent as an ask while preserving the NO price', async () => {
  const { c, calls } = liveClient();
  await c.placeOrder(buy({ side: 'no', yes_price_dollars: undefined, no_price_dollars: '0.4300' }));
  const body = calls.find(x => x.method === 'POST').body;
  assert.equal(body.side, 'ask');
  assert.equal(body.price, '0.4300');
});

test('sellPosition is IOC + reduce-only and preserves the NO exit price', async () => {
  const { c, calls } = liveClient();
  await c.sellPosition('T', 'no', 3, 41, { priceDollars: 0.41 });
  const body = calls.find(x => x.method === 'POST').body;
  assert.equal(body.side, 'bid');
  assert.equal(body.price, '0.4100');
  assert.equal(body.reduce_only, true);
  assert.equal(body.time_in_force, 'immediate_or_cancel');
});

test('the guard blocks entries at the client choke point but still allows exits', async () => {
  const { c, guard, calls } = liveClient();
  guard.halt('test');
  await assert.rejects(c.placeOrder(buy()), /blocked by trading guard/);
  assert.equal(calls.filter(x => x.method === 'POST').length, 0);
  await c.sellPosition('T', 'yes', 3, 48, { priceDollars: 0.48 }); // exit allowed under a soft halt
  assert.equal(calls.filter(x => x.method === 'POST').length, 1);

  guard.halt('auth', { hard: true });
  await assert.rejects(c.sellPosition('T', 'yes', 3, 48, { priceDollars: 0.48 }), /hard_halt/);
});

test('a 401 from Kalshi hard-halts the guard', async () => {
  const guard = new TradingGuard({ killFile: '/nonexistent', fsImpl: { existsSync: () => false } });
  const c = new KalshiClient({ TRADING_MODE: 'live', guard }, {});
  assert.throws(() => c._onHttpError({ response: { status: 401 } }));
  assert.equal(guard.hard, true);
  assert.match(guard.blockReason(), /auth_failure_401/);
});

test('fetchMarket / fetchBalance / fetchPositions / getOrder use the parsed dollar formats', async () => {
  const { c } = liveClient();
  const m = await c.fetchMarket('T');
  assert.equal(m.yesAsk, 0.52);
  assert.equal(m.yesAskCents, 52);
  const b = await c.fetchBalance();
  assert.equal(b.total, 100);
  const pos = await c.fetchPositions('KXBTC15M');
  assert.equal(pos.length, 1);
  assert.deepEqual([pos[0].side, pos[0].contracts, pos[0].avgPrice], ['no', 3, 0.4]);
  const o = await c.getOrder('live-1');
  assert.deepEqual([o.fill_count, o.taker_fill_cost, o.taker_fees], [3, 156, 6]);
});

test('fetchPositions surfaces API errors instead of returning [] (which reconcile would read as "flat")', async () => {
  const { c } = liveClient();
  c.get = async () => { throw new Error('boom'); };
  await assert.rejects(c.fetchPositions('KXBTC15M'), /boom/);
});

test('fetchMarket returns null on 404 and rethrows other errors', async () => {
  const { c } = liveClient();
  c.get = async () => { const e = new Error('nf'); e.response = { status: 404 }; throw e; };
  assert.equal(await c.fetchMarket('X'), null);
  c.get = async () => { const e = new Error('server'); e.response = { status: 500 }; throw e; };
  await assert.rejects(c.fetchMarket('X'), /server/);
});

test('runtime mode switching keeps paper+ simulated and only exact live disables paper broker', () => {
  const state = { balance: {} };
  const c = new KalshiClient({ TRADING_MODE: 'paper', PAPER_BALANCE: 100 }, state);
  assert.equal(c.tradingMode, 'paper');
  assert.equal(c.isPaper, true);
  assert.ok(c.paper);
  c.setTradingMode('paper+');
  assert.equal(c.tradingMode, 'paper+');
  assert.equal(c.isPaper, true);
  assert.ok(c.paper);
  c.setTradingMode('live');
  assert.equal(c.tradingMode, 'live');
  assert.equal(c.isPaper, false);
  assert.equal(c.paper, null);
  c.setTradingMode('paper');
  assert.equal(c.tradingMode, 'paper');
  assert.equal(c.isPaper, true);
  assert.ok(c.paper);
});
