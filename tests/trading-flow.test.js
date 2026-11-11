'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const Module = require('module');

// OrderExecutor/OrderManager need no network; stub axios only so bot/kalshi (pulled in
// indirectly) loads identically whether or not dependencies are installed.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'axios') return {};
  return originalLoad.call(this, request, ...rest);
};
const OrderManager = require('../bot/order-manager');
const RiskManager = require('../agents/skills/trading/risk-manager');
const SignalGenerator = require('../agents/skills/analysis/signal-generator');
const PositionManager = require('../agents/skills/trading/position-manager');
const OrderExecutor = require('../agents/skills/trading/order-executor');
Module._load = originalLoad;

const { TradingGuard } = require('../lib/trading-guard');
const { PaperBroker } = require('../lib/paper-broker');

// ---------- fakes ----------
class FakeState extends EventEmitter {
  constructor() {
    super();
    this.balance = { total: 100, available: 100, reserved: 0 };
    this.startingBalance = 100;
    this.openPositions = [];
    this.pendingOrders = [];
    this.closedPositions = [];
    this.activeMarkets = [];
    this.tradeLog = [];
    this.btcPrice = { binance: 100000, lastUpdate: Date.now() };
    this.stats = { totalPnL: 0, totalTrades: 0, wins: 0, losses: 0, volumeTraded: 0, totalEdge: 0, avgEdge: 0 };
  }
  addPendingOrder(o) { this.pendingOrders.push(o); }
  removePendingOrder(id) { this.pendingOrders = this.pendingOrders.filter(o => o.orderId !== id); }
  addPosition(p) { this.openPositions.push(p); }
  closePosition(orderId, result) {
    const i = this.openPositions.findIndex(p => p.orderId === orderId);
    if (i < 0) return;
    const [pos] = this.openPositions.splice(i, 1);
    this.closedPositions.push({ ...pos, ...result });
    this.stats.totalPnL += result.pnl;
    this.stats.totalTrades++;
  }
  logTrade(t) { this.tradeLog.unshift(t); }
  updateIntent() {}
  emitStats() {}
}

function ctxFor(state, extra = {}) {
  const guard = new TradingGuard({ killFile: '/nonexistent', fsImpl: { existsSync: () => false } });
  const client = { guard, tradingMode: 'paper', isPaper: true, ...extra.client };
  const skills = {
    'state-manager': { botState: state },
    'kalshi-market-data': { getClient: () => client, client },
    'analytics-recorder': { logBlockedSignal() {}, getDB: () => null },
    ...extra.skills,
  };
  return { guard, client, context: { config: { KALSHI_TAKER_FEE_RATE: 0.07, MAX_POSITION_SIZE: 5, ...extra.config }, registry: { get: n => skills[n] } } };
}

async function riskFor(state, config = {}) {
  const { context, guard, client } = ctxFor(state, { config });
  const risk = new RiskManager();
  await risk.initialize(context);
  return { risk, guard, client, context };
}

const signal = (o = {}) => ({ type: 'DIRECTIONAL_YES', ticker: 'T', side: 'yes', priceDecimal: 0.5, priceCents: 50, contracts: 4, estimatedEntryFee: 0.1, edge: 12, ...o });

// ---------- OrderManager regression ----------
test('REGRESSION: an order that fills immediately at placement becomes a tracked position', () => {
  const state = new FakeState();
  const om = new OrderManager({}, state, null, { KALSHI_TAKER_FEE_RATE: 0.07 });
  om.addPendingOrder({
    orderId: 'o1', ticker: 'T', side: 'yes', contracts: 5, fillCount: 5,
    priceCents: 52, priceDecimal: 0.52, entryFees: 0.12, entryFeeFills: 5,
    placedAt: Date.now(), closeTime: Date.now() + 600000, signalType: 'DIRECTIONAL_YES',
  });
  assert.equal(state.openPositions.length, 1, 'position must be created from the placement fill');
  const p = state.openPositions[0];
  assert.equal(p.filledContracts, 5);
  assert.ok(Math.abs(p.totalCost - (0.52 * 5 + 0.12)) < 1e-9, 'totalCost includes the entry fee');
});

test('finalizing an order replaces modelled cost with the exchange\'s actual cost + fees', async () => {
  const state = new FakeState();
  const kalshi = { getOrder: async () => ({ status: 'executed', fill_count: 5, taker_fill_cost: 260, taker_fees: 14 }) };
  const om = new OrderManager(kalshi, state, null, {});
  om.addPendingOrder({ orderId: 'o1', ticker: 'T', side: 'yes', contracts: 5, fillCount: 5, priceDecimal: 0.52, priceCents: 52, placedAt: Date.now(), closeTime: Date.now() + 1e6 });
  await om.poll();
  assert.equal(state.pendingOrders.length, 0);
  assert.equal(state.openPositions.length, 1);
  assert.ok(Math.abs(state.openPositions[0].totalCost - 2.74) < 1e-9);
});

// ---------- Risk manager ----------
test('risk: approves a normal signal and blocks on kill switch / halts', async () => {
  const state = new FakeState();
  const { risk, guard } = await riskFor(state);
  assert.equal(risk._checkSignal(signal(), state).approved, true);
  guard.halt('x');
  assert.match(risk._checkSignal(signal(), state).reason, /^halted:x/);
});

test('risk: stale Binance price blocks directional but not poly-arb signals', async () => {
  const state = new FakeState();
  state.btcPrice.lastUpdate = Date.now() - 20000;
  const { risk } = await riskFor(state);
  assert.equal(risk._checkSignal(signal(), state).reason, 'stale_spot_price');
  assert.equal(risk._checkSignal(signal({ type: 'POLY_ARB_YES' }), state).approved, true);
});

test('risk: session loss >=10% halves size, >=20% pauses, >=30% halts', async () => {
  const state = new FakeState();
  const { risk, guard } = await riskFor(state);
  state.stats.totalPnL = -11; // 11% of $100
  const s = signal({ contracts: 4 });
  const r = risk._checkSignal(s, state);
  assert.equal(r.approved, true);
  assert.equal(s.contracts, 2);
  risk._checkSignal(s, state); // idempotent: not halved again
  assert.equal(s.contracts, 2);

  state.stats.totalPnL = -21;
  assert.match(risk._checkSignal(signal(), state).reason, /^paused:session_loss/);
  assert.equal(guard.hard, false);

  state.stats.totalPnL = -31;
  assert.match(risk._checkSignal(signal(), state).reason, /^(halted|paused):/);
  assert.equal(guard.halted, true);
});

test('risk: losses before this session started do not count', async () => {
  const state = new FakeState();
  state.stats.totalPnL = -50; // from an earlier run
  const { risk } = await riskFor(state);
  assert.equal(risk._checkSignal(signal(), state).approved, true);
});

test('risk: 5 consecutive execution failures halt; no-fills and successes do not count', async () => {
  const state = new FakeState();
  const { risk, guard } = await riskFor(state);
  for (let i = 0; i < 4; i++) risk.recordExecution({ ok: false, error: new Error('x') });
  assert.equal(guard.halted, false);
  risk.recordExecution({ ok: true, noFill: true });
  assert.equal(risk.consecutiveFailures, 4);
  risk.recordExecution({ ok: true });
  assert.equal(risk.consecutiveFailures, 0);
  for (let i = 0; i < 5; i++) risk.recordExecution({ ok: false, error: new Error('x') });
  assert.equal(guard.halted, true);
});

test('risk: 401 on an order is a hard halt', async () => {
  const { risk, guard } = await riskFor(new FakeState());
  risk.recordExecution({ ok: false, error: { response: { status: 401 } } });
  assert.equal(guard.hard, true);
});

test('risk: balance below the floor halts; zero balance blocks as unavailable', async () => {
  const state = new FakeState();
  const { risk, guard } = await riskFor(state);
  state.balance = { total: 0, available: 0, reserved: 0 };
  assert.equal(risk._checkSignal(signal(), state).reason, 'balance_unavailable');
  state.balance = { total: 3, available: 3, reserved: 0 };
  risk._checkSignal(signal({ contracts: 1 }), state);
  assert.equal(guard.halted, true);
});

test('risk: portfolio exposure cap (50%) and entry fee are included in the balance check', async () => {
  const state = new FakeState();
  state.balance = { total: 10, available: 10, reserved: 0 };
  const { risk } = await riskFor(state, { MAX_POSITION_SIZE: 100 });
  assert.equal(risk._checkSignal(signal({ contracts: 20, priceDecimal: 0.5 }), state).reason, 'insufficient_balance'); // $10 + fee > $10
  assert.equal(risk._checkSignal(signal({ contracts: 12, priceDecimal: 0.5, estimatedEntryFee: 0.1 }), state).reason, 'portfolio_exposure_cap'); // $6.1 > 50% of $10
  assert.equal(risk._checkSignal(signal({ contracts: 8, priceDecimal: 0.5, estimatedEntryFee: 0.1 }), state).approved, true);
});

test('risk: fee drift twice halts trading', async () => {
  const { risk, guard } = await riskFor(new FakeState());
  risk.recordFeeObservation({ estimatedPerContract: 0.02, actualPerContract: 0.04 });
  assert.equal(guard.halted, false);
  risk.recordFeeObservation({ estimatedPerContract: 0.02, actualPerContract: 0.04 });
  assert.equal(guard.halted, true);
  const ok = await riskFor(new FakeState());
  ok.risk.recordFeeObservation({ estimatedPerContract: 0.02, actualPerContract: 0.021 });
  assert.equal(ok.guard.halted, false);
});

// ---------- Take-profit signals ----------
function sigGen() {
  const sg = new SignalGenerator();
  sg.context = { config: { KALSHI_TAKER_FEE_RATE: 0.07 } };
  return sg;
}
const mkt = { ticker: 'T', yesBid: 0.8, noBid: 0.2, feeMultiplier: 1 };

test('REGRESSION: a reconciled position with no entry price is never auto-sold', () => {
  const sg = sigGen();
  const pos = { orderId: 'r', ticker: 'T', side: 'yes', priceDecimal: 0, filledContracts: 3, totalCost: 0, closeTime: Date.now() + 5 * 60000 };
  assert.equal(sg._generateTakeProfitSignals([pos], [mkt]).length, 0);
});

test('take-profit requires the gain to survive fees', () => {
  const sg = sigGen();
  const base = { orderId: 'o', ticker: 'T', side: 'yes', filledContracts: 10, closeTime: Date.now() + 5 * 60000 };
  // Bought at 0.50 (+fee ~0.0175/contract), bid now 0.80: clear net gain -> sell
  assert.equal(sg._generateTakeProfitSignals([{ ...base, priceDecimal: 0.5, totalCost: 5.175 }], [mkt]).length, 1);
  // Bid barely above entry: gross >0 but net of both fees <0 -> hold
  assert.equal(sg._generateTakeProfitSignals([{ ...base, priceDecimal: 0.5, totalCost: 5.2 }], [{ ...mkt, yesBid: 0.52 }]).length, 0);
});

// ---------- PositionManager ----------
function pmFor(state, sell, extraClient = {}) {
  const client = { sellPosition: sell, recordSettlement() {}, fetchBalance: async () => {}, ...extraClient };
  const skills = {
    'state-manager': { botState: state },
    'kalshi-market-data': { getClient: () => client },
    'analytics-recorder': { updateOrderDirect() {}, logMarketSnapshotDirect() {} },
  };
  const pm = new PositionManager();
  pm.context = { registry: { get: n => skills[n] } };
  return pm;
}

test('take-profit P&L is net of entry and exit fees; full exit closes the position', async () => {
  const state = new FakeState();
  state.openPositions.push({ orderId: 'o', ticker: 'T', side: 'yes', filledContracts: 10, contracts: 10, priceDecimal: 0.5, totalCost: 5.2 });
  const pm = pmFor(state, async () => ({ fill_count: 10, taker_fill_cost: 800, taker_fees: 14 }));
  const r = await pm._executeTakeProfit({ orderId: 'o', ticker: 'T', side: 'yes', contracts: 10, sellPriceCents: 80, sellPriceDecimal: 0.8, reason: 'tp' });
  assert.equal(r.status, 'sold');
  assert.ok(Math.abs(r.pnl - (8.0 - 0.14 - 5.2)) < 1e-9);
  assert.equal(state.openPositions.length, 0);
});

test('REGRESSION: a partial take-profit fill keeps the remainder open', async () => {
  const state = new FakeState();
  state.openPositions.push({ orderId: 'o', ticker: 'T', side: 'yes', filledContracts: 10, contracts: 10, priceDecimal: 0.5, totalCost: 5.2 });
  const pm = pmFor(state, async () => ({ fill_count: 4, taker_fill_cost: 320, taker_fees: 6 }));
  const r = await pm._executeTakeProfit({ orderId: 'o', ticker: 'T', side: 'yes', contracts: 10, sellPriceCents: 80, sellPriceDecimal: 0.8, reason: 'tp' });
  assert.equal(r.status, 'sold');
  assert.equal(state.openPositions.length, 1);
  assert.equal(state.openPositions[0].filledContracts, 6);
  assert.ok(Math.abs(state.openPositions[0].totalCost - 5.2 * 0.6) < 1e-9);
  assert.ok(Math.abs(r.pnl - (3.2 - 0.06 - 5.2 * 0.4)) < 1e-9);
});

test('a take-profit IOC that does not fill leaves the position untouched', async () => {
  const state = new FakeState();
  state.openPositions.push({ orderId: 'o', ticker: 'T', side: 'yes', filledContracts: 10, priceDecimal: 0.5, totalCost: 5.2 });
  const pm = pmFor(state, async () => ({ fill_count: 0 }));
  const r = await pm._executeTakeProfit({ orderId: 'o', ticker: 'T', side: 'yes', contracts: 10, sellPriceCents: 80, sellPriceDecimal: 0.8 });
  assert.equal(r.status, 'pending');
  assert.equal(state.openPositions.length, 1);
});

test('settlement uses the fee-inclusive cost on the position and credits the paper ledger', async () => {
  const state = new FakeState();
  state.openPositions.push({ orderId: 'o', ticker: 'T', side: 'yes', filledContracts: 5, contracts: 5, priceDecimal: 0.52, totalCost: 2.74 });
  let settled = null;
  const pm = pmFor(state, null, {
    getOrder: async () => ({ fill_count: 5, taker_fill_cost: 260, taker_fees: 14 }),
    fetchMarket: async () => ({ result: 'yes' }),
    recordSettlement: (t, r) => { settled = [t, r]; },
  });
  const r = await pm._settlePosition('o');
  assert.equal(r.won, true);
  assert.ok(Math.abs(r.pnl - (5 - 2.74)) < 1e-9);
  assert.deepEqual(settled, ['T', 'yes']);
});

test('a RECONCILED position settles from its own data without an order lookup', async () => {
  const state = new FakeState();
  state.openPositions.push({ orderId: 'reconciled-T-no-1', type: 'RECONCILED', ticker: 'T', side: 'no', filledContracts: 3, contracts: 3, priceDecimal: 0.4, totalCost: 1.2 });
  const pm = pmFor(state, null, {
    getOrder: async () => { throw new Error('must not look up a synthetic order id'); },
    fetchMarket: async () => ({ result: 'no' }),
  });
  const r = await pm._settlePosition('reconciled-T-no-1');
  assert.equal(r.won, true);
  assert.ok(Math.abs(r.pnl - (3 - 1.2)) < 1e-9);
});

// ---------- OrderExecutor end to end against the paper broker ----------
async function executorHarness({ fillSize = 100 } = {}) {
  const state = new FakeState();
  const marketNow = { ticker: 'T', yesBid: 0.48, yesAsk: 0.52, noBid: 0.48, noAsk: 0.52, yesBidSize: fillSize, yesAskSize: fillSize, noBidSize: fillSize, noAskSize: fillSize, feeMultiplier: 1, closeTime: Date.now() + 600000 };
  state.activeMarkets = [marketNow];
  const paper = new PaperBroker({ startingBalance: 100 });
  const guard = new TradingGuard({ killFile: '/nonexistent', fsImpl: { existsSync: () => false } });
  const client = {
    guard, tradingMode: 'paper', isPaper: true, paper,
    placeOrder: async (o) => {
      const { specFromOrderData } = require('../lib/kalshi-format');
      return paper.place(specFromOrderData(o), marketNow);
    },
    getOrder: async id => paper.get(id),
    fetchBalance: async () => paper.balance(),
    recordSettlement: (t, r) => paper.settle(t, r),
  };
  const logged = [];
  const analytics = { logSignalDirect: () => 1, logMarketSnapshotDirect() {}, logOrderDirect: o => logged.push(o), getDB: () => null };
  const skills = {
    'state-manager': { botState: state },
    'kalshi-market-data': { getClient: () => client },
    'analytics-recorder': analytics,
  };
  const registry = { get: n => skills[n] };
  const context = { config: { KALSHI_TAKER_FEE_RATE: 0.07, MAX_POSITION_SIZE: 5 }, registry };
  const risk = new RiskManager();
  skills['risk-manager'] = risk;
  skills['position-manager'] = { settlePositionById() {} };
  await risk.initialize(context);
  const ex = new OrderExecutor();
  await ex.initialize(context);
  return { state, ex, risk, guard, client, paper, logged, kalshiSkill: skills['kalshi-market-data'], analytics };
}

test('executor: a filled paper order becomes a position with fees counted and balance reduced once', async () => {
  const h = await executorHarness();
  const s = signal({ priceDecimal: 0.52, priceCents: 52, contracts: 4, closeTime: Date.now() + 600000 });
  const r = await h.ex._executeSignal(s, h.state, h.kalshiSkill, h.analytics);
  assert.equal(r.status, 'executed');
  assert.equal(h.state.openPositions.length, 1, 'immediate fill must be tracked');
  assert.equal(h.state.openPositions[0].filledContracts, 4);
  assert.ok(h.state.openPositions[0].totalCost > 0.52 * 4, 'cost includes fees');
  assert.ok(h.state.balance.available < 100 - 0.52 * 4);
  assert.equal(h.risk.consecutiveFailures, 0);
});

test('REGRESSION: an IOC that does not fill leaves balance, positions and failure count untouched', async () => {
  const h = await executorHarness({ fillSize: 0 });
  const r = await h.ex._executeSignal(signal({ priceDecimal: 0.52, closeTime: Date.now() + 600000 }), h.state, h.kalshiSkill, h.analytics);
  assert.equal(r.status, 'no_fill');
  assert.equal(h.state.openPositions.length, 0);
  assert.equal(h.state.pendingOrders.length, 0);
  assert.equal(h.state.balance.available, 100);
  assert.equal(h.risk.consecutiveFailures, 0);
});

test('executor: 5 API errors in a row trip the halt; guard blocks are not counted as failures', async () => {
  const h = await executorHarness();
  h.client.placeOrder = async () => { const e = new Error('boom'); e.response = { status: 500, data: {} }; throw e; };
  for (let i = 0; i < 5; i++) {
    const r = await h.ex._executeSignal(signal({ closeTime: Date.now() + 600000 }), h.state, h.kalshiSkill, h.analytics);
    assert.equal(r.status, 'error');
  }
  assert.equal(h.guard.halted, true);

  const h2 = await executorHarness();
  h2.client.placeOrder = async () => { const e = new Error('blocked'); e.name = 'TradingBlockedError'; e.reason = 'kill_switch_file'; throw e; };
  const r = await h2.ex._executeSignal(signal({ closeTime: Date.now() + 600000 }), h2.state, h2.kalshiSkill, h2.analytics);
  assert.equal(r.status, 'blocked');
  assert.equal(h2.risk.consecutiveFailures, 0);
});

test('executor: the order sent is an immediate-or-cancel limit in dollar strings', async () => {
  const h = await executorHarness();
  let sent;
  const orig = h.client.placeOrder;
  h.client.placeOrder = async o => { sent = o; return orig(o); };
  await h.ex._executeSignal(signal({ side: 'no', type: 'DIRECTIONAL_NO', priceDecimal: 0.52, closeTime: Date.now() + 600000 }), h.state, h.kalshiSkill, h.analytics);
  assert.equal(sent.time_in_force, 'immediate_or_cancel');
  assert.equal(sent.no_price_dollars, '0.5200');
  assert.ok(!('no_price' in sent) && !('yes_price' in sent));
});

test('LIVE REPRICE: executor uses the fresh executable ask instead of stale signal price', async () => {
  const h = await executorHarness();
  h.client.isPaper = false;
  h.client.tradingMode = 'live';
  h.client.get = async () => ({ data: { orderbook_fp: { yes_dollars_fp: [['0.4400','10']], no_dollars_fp: [['0.4500','10']] } } });
  let sent;
  h.client.placeOrder = async o => { sent = o; return { order_id: 'live-rp-1', status: 'canceled', fill_count: 0 }; };
  const s = signal({ side: 'yes', type: 'DIRECTIONAL_YES', priceDecimal: 0.52, priceCents: 52, modelProb: 0.80, edge: 25, contracts: 4, closeTime: Date.now() + 600000 });
  const r = await h.ex._executeSignal(s, h.state, h.kalshiSkill, h.analytics);
  assert.equal(r.status, 'no_fill');
  assert.equal(sent.yes_price_dollars, '0.5500');
});

test('LIVE REPRICE: executor skips when the fresh fee-adjusted edge falls below MIN_EDGE', async () => {
  const h = await executorHarness();
  h.ex.context.config.MIN_EDGE = 10;
  h.client.isPaper = false;
  h.client.tradingMode = 'live';
  h.client.get = async () => ({ data: { orderbook_fp: { yes_dollars_fp: [['0.3900','10']], no_dollars_fp: [['0.4000','10']] } } });
  let submitted = false;
  h.client.placeOrder = async () => { submitted = true; throw new Error('must not submit'); };
  const s = signal({ side: 'yes', type: 'DIRECTIONAL_YES', priceDecimal: 0.50, priceCents: 50, modelProb: 0.65, edge: 14, contracts: 4, closeTime: Date.now() + 600000 });
  const r = await h.ex._executeSignal(s, h.state, h.kalshiSkill, h.analytics);
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /^fresh_edge_below_min:/);
  assert.equal(submitted, false);
});


test('LIVE REPRICE: NO execution uses the fresh order-book ask', async () => {
  const h = await executorHarness();
  h.client.isPaper = false;
  h.client.tradingMode = 'live';
  // NO ask 0.57 is implied by the best YES bid at 0.43.
  h.client.get = async () => ({ data: { orderbook_fp: { yes_dollars_fp: [['0.4300','20']], no_dollars_fp: [['0.4200','20']] } } });
  let sent;
  h.client.placeOrder = async o => { sent = o; return { order_id: 'live-rp-no', status: 'canceled', fill_count: 0 }; };
  const s = signal({ side: 'no', type: 'DIRECTIONAL_NO', priceDecimal: 0.52, priceCents: 52, modelProb: 0.82, edge: 25, contracts: 4, closeTime: Date.now() + 600000 });
  const r = await h.ex._executeSignal(s, h.state, h.kalshiSkill, h.analytics);
  assert.equal(r.status, 'no_fill');
  assert.equal(sent.no_price_dollars, '0.5700');
});

test('LIVE REPRICE: missing order-book ask blocks instead of submitting a stale IOC', async () => {
  const h = await executorHarness();
  h.client.isPaper = false;
  h.client.tradingMode = 'live';
  h.client.get = async () => ({ data: { orderbook_fp: { yes_dollars_fp: [], no_dollars_fp: [] } } });
  let submitted = false;
  h.client.placeOrder = async () => { submitted = true; throw new Error('must not submit'); };
  const s = signal({ side: 'yes', type: 'DIRECTIONAL_YES', priceDecimal: 0.52, priceCents: 52, modelProb: 0.80, edge: 25, contracts: 4, closeTime: Date.now() + 600000 });
  const r = await h.ex._executeSignal(s, h.state, h.kalshiSkill, h.analytics);
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'fresh_orderbook_ask_unavailable');
  assert.equal(submitted, false);
});

test('REGRESSION: paper position settles after original simulated order is lost', async () => {
  const state = new FakeState();
  state.openPositions.push({ orderId:'paper-lost', ticker:'T', side:'yes', contracts:4, filledContracts:4, priceDecimal:.52, totalCost:2.16, entryFees:.08, mlObservationId:null });
  let getOrderCalled = false;
  const client = { getOrder: async()=>{ getOrderCalled=true; throw new Error('paper broker: unknown order paper-lost'); }, fetchMarket:async()=>({ticker:'T',result:'yes'}), recordSettlement(){}, fetchBalance:async()=>{} };
  const pm = new PositionManager(); pm.context={registry:{get:n=> n==='state-manager'?{botState:state}:n==='kalshi-market-data'?{getClient:()=>client}:{updateOrderDirect(){},logMarketSnapshotDirect(){}}},config:{TRADING_MODE:'paper+'}};
  const r=await pm._settlePosition('paper-lost');
  assert.equal(getOrderCalled,false); assert.equal(r.settled,true); assert.ok(Math.abs(r.pnl-1.84)<1e-9);
});
