'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/kalshi-format');

const dollarMarket = {
  ticker: 'KXBTC15M-26NOV011500-00', event_ticker: 'KXBTC15M-26NOV011500', status: 'active',
  open_time: '2026-11-01T21:45:00Z', close_time: '2026-11-01T22:00:00Z', result: '',
  yes_bid_dollars: '0.4800', yes_ask_dollars: '0.5200', no_bid_dollars: '0.4800', no_ask_dollars: '0.5200',
  last_price_dollars: '0.5000', yes_bid_size_fp: '120.00', yes_ask_size_fp: '35.00',
};

test('parseMarket reads dollar strings and derives cents/sizes', () => {
  const m = F.parseMarket(dollarMarket);
  assert.equal(m.yesAsk, 0.52);
  assert.equal(m.yesBid, 0.48);
  assert.equal(m.noAsk, 0.52);
  assert.equal(m.yesAskCents, 52);
  assert.equal(m.lastPrice, 0.5);
  assert.equal(m.openTime, Date.parse('2026-11-01T21:45:00Z'));
  assert.equal(m.closeTime, Date.parse('2026-11-01T22:00:00Z'));
  // Buying YES lifts the YES ask (size 35); buying NO hits YES bids (size 120).
  assert.equal(m.yesAskSize, 35);
  assert.equal(m.noAskSize, 120);
  assert.equal(m.noBidSize, 35);
});

test('parseMarket never yields NaN when only legacy cent fields are present', () => {
  const m = F.parseMarket({ ticker: 'T', yes_ask: 57, yes_bid: 55, no_ask: 45, no_bid: 43, open_time: '2026-01-01T00:00:00Z', close_time: '2026-01-01T00:15:00Z' });
  assert.equal(m.yesAsk, 0.57);
  assert.equal(m.noBid, 0.43);
});

test('parseMarket marks a missing quote as 0 so `!market.yesAsk` guards still skip it', () => {
  const m = F.parseMarket({ ticker: 'T', open_time: '2026-01-01T00:00:00Z', close_time: '2026-01-01T00:15:00Z' });
  assert.equal(m.yesAsk, 0);
  assert.equal(m.noAsk, 0);
  assert.ok(!Number.isNaN(m.yesBid));
});

test('parseMarket does not emit undefined keys that would clobber state on a spread-merge', () => {
  const m = F.parseMarket(dollarMarket);
  assert.ok(!('feeMultiplier' in m));
  const merged = { ...{ feeMultiplier: 1 }, ...m };
  assert.equal(merged.feeMultiplier, 1);
});

test('formatPrice / formatCount produce Kalshi fixed-point strings and reject bad input', () => {
  assert.equal(F.formatPrice(0.56), '0.5600');
  assert.equal(F.formatCount(10), '10.00');
  assert.throws(() => F.formatPrice(0), RangeError);
  assert.throws(() => F.formatPrice(1), RangeError);
  assert.throws(() => F.formatPrice('abc'), RangeError);
  assert.throws(() => F.formatCount(0), RangeError);
});

test('V2 order body: direction changes side but preserves the submitted price', () => {
  const base = { ticker: 'T', count: 3, timeInForce: 'immediate_or_cancel', clientOrderId: 'c1' };
  const buyYes = F.buildV2OrderBody({ ...base, outcomeSide: 'yes', action: 'buy', limitPrice: 0.57 });
  assert.deepEqual([buyYes.side, buyYes.price], ['bid', '0.5700']);
  const buyNo = F.buildV2OrderBody({ ...base, outcomeSide: 'no', action: 'buy', limitPrice: 0.43 });
  assert.deepEqual([buyNo.side, buyNo.price], ['ask', '0.4300']);
  const sellYes = F.buildV2OrderBody({ ...base, outcomeSide: 'yes', action: 'sell', limitPrice: 0.60, reduceOnly: true });
  assert.deepEqual([sellYes.side, sellYes.price, sellYes.reduce_only], ['ask', '0.6000', true]);
  const sellNo = F.buildV2OrderBody({ ...base, outcomeSide: 'no', action: 'sell', limitPrice: 0.41, reduceOnly: true });
  assert.deepEqual([sellNo.side, sellNo.price], ['bid', '0.4100']);
  assert.equal(buyYes.count, '3.00');
  assert.equal(buyYes.time_in_force, 'immediate_or_cancel');
  assert.equal(buyYes.self_trade_prevention_type, 'taker_at_cross');
  assert.equal(buyYes.client_order_id, 'c1');
  assert.ok(!('action' in buyYes) && !('yes_price' in buyYes));
  const routed = F.buildV2OrderBody({ ...base, outcomeSide: 'no', action: 'buy', limitPrice: 0.49, subaccount: 0, exchangeIndex: -1 });
  assert.equal(routed.subaccount, 0);
  assert.equal(routed.exchange_index, -1);
  assert.equal(routed.price, '0.4900');
});

test('specFromOrderData prefers dollar fields and falls back to legacy cents', () => {
  const a = F.specFromOrderData({ ticker: 'T', action: 'buy', side: 'yes', count: 2, yes_price_dollars: '0.5500', yes_price: 99 });
  assert.equal(a.limitPrice, 0.55);
  const b = F.specFromOrderData({ ticker: 'T', action: 'buy', side: 'no', count: 2, no_price: 41 });
  assert.equal(b.limitPrice, 0.41);
  assert.throws(() => F.specFromOrderData({ ticker: 'T', action: 'buy', side: 'yes', count: 1 }), TypeError);
});

test('create-order response (flat V2 shape) is normalized; NO fills preserve V2 price', () => {
  const yes = F.parseCreateOrderResponse(
    { order_id: 'o1', fill_count: '3.00', remaining_count: '0.00', average_fill_price: '0.5700', average_fee_paid: '0.0200' },
    { outcomeSide: 'yes', timeInForce: 'immediate_or_cancel', ticker: 'T' });
  assert.equal(yes.fill_count, 3);
  assert.equal(yes.status, 'executed');
  assert.equal(yes.average_fill_price, 0.57);
  assert.equal(yes.taker_fill_cost, 171); // cents
  assert.equal(yes.taker_fees, 6);        // cents

  const no = F.parseCreateOrderResponse(
    { order_id: 'o2', fill_count: '2.00', remaining_count: '1.00', average_fill_price: '0.5700', average_fee_paid: '0.0200' },
    { outcomeSide: 'no', timeInForce: 'immediate_or_cancel', ticker: 'T' });
  assert.equal(no.average_fill_price, 0.57);
  assert.equal(no.taker_fill_cost, 114);
  assert.equal(no.status, 'executed');       // IOC remainder is cancelled: terminal
});

test('IOC with no fill is terminal "canceled", not a resting order', () => {
  const r = F.parseCreateOrderResponse({ order_id: 'o3', fill_count: '0.00', remaining_count: '3.00' },
    { outcomeSide: 'yes', timeInForce: 'immediate_or_cancel', ticker: 'T' });
  assert.equal(r.status, 'canceled');
  assert.equal(r.fill_count, 0);
  assert.equal(r.taker_fill_cost, 0);
});

test('GET order: fp counts and *_dollars costs become legacy-shaped numbers (cents)', () => {
  const o = F.parseOrder({
    order_id: 'o1', status: 'executed', outcome_side: 'yes',
    fill_count_fp: '4.00', remaining_count_fp: '0.00', initial_count_fp: '4.00',
    taker_fill_cost_dollars: '2.2800', maker_fill_cost_dollars: '0.0000',
    taker_fees_dollars: '0.0800', maker_fees_dollars: '0.000000',
  });
  assert.equal(o.fill_count, 4);
  assert.equal(o.taker_fill_cost, 228);
  assert.equal(o.taker_fees, 8);
});

test('balance and positions parse dollar/fp fields', () => {
  const b = F.parseBalance({ balance: 12345, balance_dollars: '123.4500', portfolio_value: 500 });
  assert.equal(b.total, 123.45);
  assert.equal(b.available, 123.45);
  assert.equal(b.portfolioValue, 5);
  assert.equal(F.parseBalance({ balance: 5000 }).total, 50); // cents fallback

  const yes = F.parsePosition({ ticker: 'T', position_fp: '10.00', market_exposure_dollars: '5.5000' });
  assert.deepEqual([yes.side, yes.contracts, yes.avgPrice], ['yes', 10, 0.55]);
  const no = F.parsePosition({ ticker: 'T', position_fp: '-4.00', market_exposure_dollars: '1.6000' });
  assert.deepEqual([no.side, no.contracts, no.avgPrice], ['no', 4, 0.4]);
  assert.equal(F.parsePosition({ ticker: 'T', position_fp: '0.00' }), null);
});
