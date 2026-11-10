'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaperBroker } = require('../lib/paper-broker');
const { TradingGuard } = require('../lib/trading-guard');
const { estimateTakerFeeDollars } = require('../lib/kalshi-economics');

const market = { ticker: 'T', yesBid: 0.48, yesAsk: 0.52, noBid: 0.48, noAsk: 0.52, yesBidSize: 100, yesAskSize: 10, noBidSize: 10, noAskSize: 100 };
const spec = (o = {}) => ({ ticker: 'T', outcomeSide: 'yes', action: 'buy', count: 5, limitPrice: 0.52, timeInForce: 'immediate_or_cancel', clientOrderId: 'x', ...o });

test('paper buy fills at the ask, charges modelled fee + latency penalty, debits cash', () => {
  const b = new PaperBroker({ startingBalance: 100, latencyPenalty: 0.01 });
  const o = b.place(spec(), market);
  const fee = estimateTakerFeeDollars(0.52, 5, 0.07, 1);
  assert.equal(o.fill_count, 5);
  assert.equal(o.status, 'executed');
  assert.equal(o.average_fill_price, 0.52);
  assert.ok(Math.abs(o.taker_fees - (fee + 0.05) * 100) < 1e-6);
  assert.ok(Math.abs(b.cash - (100 - 2.6 - fee - 0.05)) < 1e-9);
  assert.equal(b.held('T', 'yes'), 5);
});

test('paper fill is capped by displayed depth; unknown depth means no fill', () => {
  const b = new PaperBroker();
  assert.equal(b.place(spec({ count: 50 }), market).fill_count, 10); // yesAskSize = 10
  const noDepth = b.place(spec(), { ...market, yesAskSize: undefined });
  assert.equal(noDepth.fill_count, 0);
  assert.equal(noDepth.status, 'canceled');
});

test('paper order below the ask does not fill (IOC at limit)', () => {
  const b = new PaperBroker();
  assert.equal(b.place(spec({ limitPrice: 0.51 }), market).fill_count, 0);
});

test('paper NO buy uses the NO ask and NO depth', () => {
  const b = new PaperBroker();
  const o = b.place(spec({ outcomeSide: 'no', limitPrice: 0.52, count: 7 }), market);
  assert.equal(o.fill_count, 7);
  assert.equal(b.held('T', 'no'), 7);
});

test('paper rejects an order that exceeds cash', () => {
  const b = new PaperBroker({ startingBalance: 1 });
  assert.throws(() => b.place(spec({ count: 5 }), market), /insufficient balance/);
});

test('paper sells are reduce-only against the ledger and credit proceeds net of fees', () => {
  const b = new PaperBroker({ startingBalance: 100 });
  assert.equal(b.place(spec({ action: 'sell', limitPrice: 0.48 }), market).fill_count, 0); // nothing held
  b.place(spec({ count: 4 }), market);
  const cashAfterBuy = b.cash;
  const sell = b.place(spec({ action: 'sell', limitPrice: 0.48, count: 10 }), market);
  assert.equal(sell.fill_count, 4); // capped at holdings
  assert.ok(b.cash > cashAfterBuy);
  assert.equal(b.held('T', 'yes'), 0);
});

test('settlement pays $1 per winning contract and clears the ledger', () => {
  const b = new PaperBroker({ startingBalance: 100 });
  b.place(spec({ count: 5 }), market);
  const before = b.cash;
  assert.equal(b.settle('T', 'yes'), 5);
  assert.equal(b.cash, before + 5);
  b.place(spec({ count: 5 }), market);
  const mid = b.cash;
  assert.equal(b.settle('T', 'no'), 0);
  assert.equal(b.cash, mid);
});

test('restore rebuilds cash and holdings from persisted positions', () => {
  const b = new PaperBroker({ startingBalance: 100 });
  b.restore({ positions: [{ ticker: 'T', side: 'yes', filledContracts: 5, totalCost: 2.7 }], realizedPnl: -1.5 });
  assert.equal(b.held('T', 'yes'), 5);
  assert.ok(Math.abs(b.cash - (100 - 1.5 - 2.7)) < 1e-9);
});

test('guard: kill file, disabled flag, halt, hard halt, pause, resume', () => {
  let t = 1000;
  let killed = false;
  const g = new TradingGuard({ killFile: '/x', now: () => t, fsImpl: { existsSync: () => killed } });
  assert.equal(g.blockReason(), null);

  killed = true;
  assert.equal(g.blockReason(), 'kill_switch_file');
  killed = false;

  g.pause(60000, 'loss');
  assert.match(g.blockReason(), /^paused:loss/);
  t += 60001;
  assert.equal(g.blockReason(), null);

  g.halt('failures');
  assert.match(g.blockReason(), /^halted:failures/);
  assert.equal(g.resume(), true);
  assert.equal(g.blockReason(), null);

  g.halt('auth', { hard: true });
  assert.equal(g.resume(), false);
  assert.match(g.blockReason(), /^halted:auth/);

  assert.equal(new TradingGuard({ enabled: false, fsImpl: { existsSync: () => false } }).blockReason(), 'trading_disabled');
});
