const test = require('node:test');
const assert = require('node:assert/strict');

const supabase = require('../lib/supabase');
const PositionManager = require('../agents/skills/trading/position-manager');

test('ML feature observations use stable observation_id upserts and start unlabeled', async () => {
  const originalEnabled = supabase.enabled;
  const originalClient = supabase.client;
  let captured = null;
  supabase.enabled = true;
  supabase.client = {
    from(table) {
      assert.equal(table, 'ml_features');
      return {
        async upsert(record, options) {
          captured = { record, options };
          return { error: null };
        },
      };
    },
  };
  try {
    await supabase.logFeatures({
      observationId: 'kalshi-order:abc123', ticker: 'BTC', signalType: 'DIRECTIONAL_YES',
      predictedSide: 'yes', vector: [1, 2, 3], label: null,
    });
    assert.equal(captured.record.observation_id, 'kalshi-order:abc123');
    assert.equal(captured.record.label, null);
    assert.equal(captured.record.predicted_side, 'yes');
    assert.deepEqual(captured.options, { onConflict: 'observation_id' });
  } finally {
    supabase.enabled = originalEnabled;
    supabase.client = originalClient;
  }
});

test('settlement label is 1/0 from original side versus actual Kalshi result', async () => {
  const originalEnabled = supabase.enabled;
  const originalClient = supabase.client;
  const updates = [];
  supabase.enabled = true;
  supabase.client = {
    from() {
      return {
        update(record) {
          updates.push(record);
          return { eq() { return { async is() { return { error: null }; } }; } };
        },
      };
    },
  };
  try {
    await supabase.labelFeatureObservation('obs-yes', 'yes', 'yes');
    await supabase.labelFeatureObservation('obs-no', 'no', 'yes');
    assert.equal(updates[0].label, 1);
    assert.equal(updates[1].label, 0);
  } finally {
    supabase.enabled = originalEnabled;
    supabase.client = originalClient;
  }
});

test('full take-profit does not determine ML label; later Kalshi settlement labels original prediction', async () => {
  const pm = new PositionManager();
  const originalLabel = supabase.labelFeatureObservation;
  const labels = [];
  supabase.labelFeatureObservation = async (...args) => labels.push(args);

  const state = {
    openPositions: [], pendingOrders: [],
    closedPositions: [{
      orderId: 'order-tp', ticker: 'BTC-MKT', side: 'yes', mlPredictedSide: 'yes',
      mlObservationId: 'kalshi-order:order-tp', exitType: 'TAKE_PROFIT', won: true, pnl: 1.25,
    }],
    emit() {},
  };
  const kalshi = { getClient: () => ({ fetchMarket: async () => ({ result: 'no' }) }) };
  const registry = { get(name) { if (name === 'state-manager') return { botState: state }; if (name === 'kalshi-market-data') return kalshi; if (name === 'analytics-recorder') return {}; throw new Error(name); } };
  pm.context = { registry };

  try {
    const result = await pm._settlePosition('order-tp');
    assert.equal(result.mlOnly, true);
    assert.deepEqual(labels, [['kalshi-order:order-tp', 'no', 'yes']]);
    assert.equal(state.closedPositions[0].won, true, 'financial TP result is preserved');
    assert.equal(state.closedPositions[0].mlSettlementResult, 'no');
  } finally {
    supabase.labelFeatureObservation = originalLabel;
  }
});

test('single-class canonical market dataset defers training', async () => {
  const mlPipeline = require('../lib/ml-pipeline');
  const supabase = require('../lib/supabase');
  const old = supabase.getTrainingData;
  supabase.getTrainingData = async () => Array.from({length:60}, (_,i) => ({ticker:`T${i%3}`, features:Array(27).fill(0), label:1, settled_result:'yes'}));
  try { assert.equal(await mlPipeline.train(), false); assert.equal(mlPipeline.trained, false); }
  finally { supabase.getTrainingData = old; }
});
