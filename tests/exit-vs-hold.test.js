const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evh-')), 'log.jsonl');
process.env.EXIT_HOLD_LOG = logFile;
const E = require('../lib/exit-hold-log');
const PositionManager = require('../agents/skills/trading/position-manager');
const supabase = require('../lib/supabase');

function setup(mode, result) {
  const closedTp = { orderId: 'o1', ticker: 'T', side: 'yes', exitType: 'TAKE_PROFIT', mlObservationId: 'm1',
    originalFilledContracts: 4, originalTotalCost: 2.6, pnl: 0.8, entryTime: 1, settleTime: 2 };
  const state = { openPositions: [], closedPositions: [closedTp], pendingOrders: [], emit() {} };
  const pm = new PositionManager();
  pm.context = { config: { TRADING_MODE: mode }, registry: { get: n => ({
    'state-manager': { botState: state },
    'kalshi-market-data': { getClient: () => ({ fetchMarket: async () => ({ result }) }) },
    'analytics-recorder': {},
  })[n] } };
  return { pm, closedTp };
}

test('PAPER mode now records exit-vs-hold once, durably, without touching P&L', async () => {
  fs.rmSync(logFile, { force: true });
  const old = supabase.labelFeatureObservation; supabase.labelFeatureObservation = async () => {};
  const oldLog = console.log; console.log = () => {};
  try {
    const { pm, closedTp } = setup('paper', 'yes');
    await pm._settlePosition('o1');
    await pm._settlePosition('o1');
    assert.equal(closedTp.pnl, 0.8);
    assert.ok(Math.abs(closedTp.holdToSettlementPnl - 1.4) < 1e-9);
    assert.ok(Math.abs(closedTp.exitVsHoldDelta - (0.8 - 1.4)) < 1e-9);
    const rows = E.load();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, 'paper');
  } finally { supabase.labelFeatureObservation = old; console.log = oldLog; }
});

test('losing settlement makes early exit look better', async () => {
  fs.rmSync(logFile, { force: true });
  const old = supabase.labelFeatureObservation; supabase.labelFeatureObservation = async () => {};
  const oldLog = console.log; console.log = () => {};
  try {
    const { pm, closedTp } = setup('paper', 'no');
    await pm._settlePosition('o1');
    assert.ok(Math.abs(closedTp.exitVsHoldDelta - (0.8 + 2.6)) < 1e-9);
  } finally { supabase.labelFeatureObservation = old; console.log = oldLog; }
});

test('summary: insufficient data, then a clear holding-better verdict', () => {
  assert.equal(E.summarize([]).status, 'INSUFFICIENT_DATA');
  const rows = Array.from({ length: 320 }, (_, i) => ({ orderId: 'o' + i, ticker: 'M' + (i % 80), pnl: .5, holdPnl: 1, delta: -.5 + (i % 7) * .01 }));
  const s = E.summarize(rows);
  assert.equal(s.status, 'HOLDING_BETTER');
  assert.equal(s.markets, 80);
});
