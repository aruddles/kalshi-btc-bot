const test = require('node:test');
const assert = require('node:assert/strict');

const supabase = require('../lib/supabase');
const MLDataCollector = require('../agents/skills/analysis/ml-data-collector');

test('collector writes stable unlabeled market snapshots without requiring a trade', async () => {
  const rows = [];
  const oldEnabled = supabase.enabled;
  const oldLog = supabase.logFeatures;
  supabase.enabled = true;
  supabase.logFeatures = async row => rows.push(row);

  const state = {
    activeMarkets: [{ ticker: 'KXBTC15M-X', closeTime: Date.now() + 600000, yesAsk: .55, noAsk: .46, yesBid: .54, noBid: .45 }],
    btcPrice: { binance: 100000 }, marketOpenPrices: { 'KXBTC15M-X': 99900 },
    model: { impliedProbUp: .60, volatility: .001, trend: 'BULLISH', trendStrength: .7, trendROC: .1 },
    stats: { totalTrades: 0, wins: 0, totalPnL: 0, streak: 0 }, balance: { available: 10 },
  };
  const c = new MLDataCollector();
  c.context = { registry: { get: name => name === 'state-manager' ? { botState: state } : null } };
  c.cadenceMs = 5000;
  await c._collect();
  await c._collect();

  assert.equal(rows.length, 2);
  assert.equal(rows[0].observationId, rows[1].observationId);
  assert.equal(rows[0].signalType, 'MARKET_SNAPSHOT_YES');
  assert.equal(rows[0].predictedSide, 'yes');
  assert.equal(rows[0].label, null);
  assert.equal(rows[0].ticker, 'KXBTC15M-X');
  assert.ok(Array.isArray(rows[0].vector));

  supabase.enabled = oldEnabled;
  supabase.logFeatures = oldLog;
});

test('collector labels snapshots only from actual Kalshi settlement', async () => {
  const labels = [];
  const oldEnabled = supabase.enabled;
  const oldLabel = supabase.labelMarketObservations;
  supabase.enabled = true;
  supabase.labelMarketObservations = async (ticker, result) => labels.push({ ticker, result });

  const c = new MLDataCollector();
  c.pendingTickers.add('KXBTC15M-X');
  c.context = { registry: { get: name => {
    if (name === 'kalshi-market-data') return { getClient: () => ({ fetchMarket: async () => ({ result: 'no' }) }) };
    return null;
  } } };
  await c._labelSettled();
  assert.deepEqual(labels, [{ ticker: 'KXBTC15M-X', result: 'no' }]);
  assert.equal(c.pendingTickers.size, 0);

  supabase.enabled = oldEnabled;
  supabase.labelMarketObservations = oldLabel;
});

test('canonical settlement mapping is YES -> 1 and NO -> 0', async () => {
  const oldEnabled=supabase.enabled, oldClient=supabase.client; const updates=[];
  supabase.enabled=true;
  supabase.client={from:()=>({update:obj=>{updates.push(obj);const chain={eq:()=>chain,is:async()=>({error:null})};return chain;}})};
  try { await supabase.labelMarketObservations('Y','yes'); await supabase.labelMarketObservations('N','no');
    assert.equal(updates[0].label,1); assert.equal(updates[0].settled_result,'yes'); assert.equal(updates[1].label,0); assert.equal(updates[1].settled_result,'no');
  } finally {supabase.enabled=oldEnabled;supabase.client=oldClient;}
});
