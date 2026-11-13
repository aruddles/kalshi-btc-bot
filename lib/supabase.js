/**
 * Supabase Client — Persistent storage for state, analytics, and ML features.
 *
 * Replaces SQLite (better-sqlite3) for serverless/Vercel deployment.
 * Tables:
 *   - bot_state       : Persisted bot state (JSON blob, single row)
 *   - signals          : Signal generation events (ML training data)
 *   - orders           : Order lifecycle tracking
 *   - market_snapshots : Market state at key moments
 *   - ml_features      : Extracted features for ML model training
 *   - ml_predictions   : Model predictions and outcomes (for feedback loop)
 *   - embeddings       : RAG vector embeddings for trade context retrieval
 */

let createClient;
try {
  createClient = require('@supabase/supabase-js').createClient;
} catch {
  // Supabase not installed — provide stub for local dev
  createClient = null;
}

class SupabaseStore {
  constructor() {
    this.client = null;
    this.enabled = false;
  }

  initialize() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !key || !createClient) {
      console.log('[Supabase] Not configured — using local file storage fallback');
      return;
    }

    this.client = createClient(url, key);
    this.enabled = true;
    console.log('[Supabase] Connected');
  }

  // ===== Bot State =====

  async saveState(stateJson) {
    if (!this.enabled) return;
    const { error } = await this.client
      .from('bot_state')
      .upsert({ id: 1, state: stateJson, updated_at: new Date().toISOString() });
    if (error) console.error('[Supabase] saveState error:', error.message);
  }

  async loadState() {
    if (!this.enabled) return null;
    const { data, error } = await this.client
      .from('bot_state')
      .select('state')
      .eq('id', 1)
      .single();
    if (error || !data) return null;
    return data.state;
  }

  // ===== Signal Logging (ML Training Data) =====

  async logSignal(signal) {
    if (!this.enabled) return null;
    const record = {
      ts: new Date().toISOString(),
      type: signal.type,
      ticker: signal.ticker,
      side: signal.side,
      price_cents: signal.priceCents,
      edge: signal.edge,
      model_prob: signal.modelProb,
      contracts: signal.contracts,
      reason: signal.reason,
      executed: signal.executed ?? true,
      blocked_reason: signal.blockedReason || null,
    };
    const { data, error } = await this.client.from('signals').insert(record).select('id').single();
    if (error) { console.error('[Supabase] logSignal error:', error.message); return null; }
    return data?.id;
  }

  async updateSignalOutcome(signalId, outcome) {
    if (!this.enabled || !signalId) return;
    const { error } = await this.client
      .from('signals')
      .update({
        outcome_won: outcome.won,
        outcome_pnl: outcome.pnl,
        settled_at: new Date().toISOString(),
      })
      .eq('id', signalId);
    if (error) console.error('[Supabase] updateSignalOutcome error:', error.message);
  }

  // ===== Order Logging =====

  async logOrder(order) {
    if (!this.enabled) return;
    const { error } = await this.client.from('orders').insert({
      ts: new Date().toISOString(),
      order_id: order.order_id,
      client_order_id: order.client_order_id,
      signal_id: order.signal_id || null,
      ticker: order.ticker,
      side: order.side,
      action: order.action,
      price_cents: order.price_cents,
      count: order.count,
      status: order.status,
      // Columns are INTEGER (cents); Kalshi's fixed-point fees can carry sub-cent
      // precision, which Postgres would reject. In-memory P&L keeps full precision.
      fill_count: Math.round(order.fill_count || 0),
      taker_fill_cost: Math.round(order.taker_fill_cost || 0),
      taker_fees: Math.round(order.taker_fees || 0),
      close_time: order.close_time,
    });
    if (error) console.error('[Supabase] logOrder error:', error.message);
  }

  // ===== Market Snapshots =====

  async logMarketSnapshot(snapshot) {
    if (!this.enabled) return;
    const { error } = await this.client.from('market_snapshots').insert({
      ts: new Date().toISOString(),
      ticker: snapshot.ticker,
      yes_bid: snapshot.yesBid,
      yes_ask: snapshot.yesAsk,
      no_bid: snapshot.noBid,
      no_ask: snapshot.noAsk,
      btc_price: snapshot.btcPrice,
      time_remaining_s: snapshot.timeRemainingS,
      context: snapshot.context,
    });
    if (error) console.error('[Supabase] logMarketSnapshot error:', error.message);
  }

  // ===== ML Features (for model training) =====

  async logFeatures(features) {
    if (!this.enabled) return;
    const record = {
      observation_id: features.observationId,
      ts: features.ts || new Date().toISOString(),
      ticker: features.ticker,
      signal_type: features.signalType,
      predicted_side: features.predictedSide || null,
      features: features.vector, // JSONB array of numeric features
      label: features.label ?? null, // stays NULL until actual Kalshi settlement
      signal_id: features.signalId || null,
    };
    // collector_meta needs the v3.1 migration; without it, retry without the column once and stop sending it.
    if (features.collectorMeta && !this.collectorMetaUnsupported) record.collector_meta = features.collectorMeta;
    let { error } = await this.client.from('ml_features').upsert(record, { onConflict: 'observation_id' });
    if (error && record.collector_meta && /collector_meta/i.test(error.message || '')) {
      this.collectorMetaUnsupported = true;
      console.warn('[Supabase] ml_features.collector_meta missing; run the v3.1 migration in lib/supabase-migrations.sql. Continuing without it.');
      delete record.collector_meta;
      ({ error } = await this.client.from('ml_features').upsert(record, { onConflict: 'observation_id' }));
    }
    if (error) console.error('[Supabase] logFeatures error:', error.message);
  }

  async labelFeatureObservation(observationId, settledResult, predictedSide) {
    if (!this.enabled || !observationId) return;
    if (settledResult !== 'yes' && settledResult !== 'no') return;
    const label = predictedSide === settledResult ? 1 : 0;
    const { error } = await this.client
      .from('ml_features')
      .update({ label, settled_result: settledResult, labeled_at: new Date().toISOString() })
      .eq('observation_id', observationId)
      .is('label', null);
    if (error) console.error('[Supabase] labelFeatureObservation error:', error.message);
  }

  async labelMarketObservations(ticker, settledResult) {
    if (!this.enabled || !ticker) return;
    if (settledResult !== 'yes' && settledResult !== 'no') return;
    const label = settledResult === 'yes' ? 1 : 0;
    const { error } = await this.client
      .from('ml_features')
      .update({ label, settled_result: settledResult, labeled_at: new Date().toISOString() })
      .eq('ticker', ticker)
      .eq('signal_type', 'MARKET_SNAPSHOT_YES')
      .is('label', null);
    if (error) console.error('[Supabase] labelMarketObservations error:', error.message);
  }

  async getUnlabeledMarketTickers(limit = 500) {
    if (!this.enabled) return [];
    const { data, error } = await this.client
      .from('ml_features')
      .select('ticker')
      .eq('signal_type', 'MARKET_SNAPSHOT_YES')
      .is('label', null)
      .not('ticker', 'is', null)
      .limit(limit);
    if (error) { console.error('[Supabase] getUnlabeledMarketTickers error:', error.message); return []; }
    return [...new Set((data || []).map(r => r.ticker).filter(Boolean))];
  }

  async getTrainingData(limit = null, { pageSize = 1000, retries = 3 } = {}) {
    if (!this.enabled) return [];

    // Supabase caps responses at 1,000 rows, so page explicitly. Keyset-paginate on
    // the primary key (same fix as getSettlementShadowRows): ORDER BY the unindexed
    // ts with OFFSET re-sorted the whole table per page and hit the statement
    // timeout once ml_features passed ~100k rows. Sorted by ts in JS afterwards so
    // callers still get chronological order.
    const rows = [];
    const page = (lastId, n) => this.client
      .from('ml_features')
      .select('id, ticker, ts, features, label, settled_result')
      .eq('signal_type', 'MARKET_SNAPSHOT_YES')
      .not('label', 'is', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(n);
    for (let lastId = 0; limit == null || rows.length < limit;) {
      const n = limit == null ? pageSize : Math.min(pageSize, limit - rows.length);
      let { data, error } = await page(lastId, n);
      for (let attempt = 1; error && /statement timeout/i.test(error.message || '') && attempt <= retries; attempt++) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        ({ data, error } = await page(lastId, n));
      }
      if (error) {
        console.error(`[Supabase] getTrainingData error after ${rows.length} rows:`, error.message);
        return [];
      }
      if (!data || !data.length) break;
      for (const { id, ...r } of data) rows.push(r);
      lastId = data[data.length - 1].id;
      if (data.length < n) break;
    }
    return rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  // v3.1 shadow-model rows (requires collector_meta migration). Read-only.
  // Keyset-paginated on the primary key: ordering by the unindexed ts with OFFSET
  // made Postgres sort the whole filtered set for every page and hit the statement
  // timeout. Rows come back in insertion (≈ time) order; callers sort if needed.
  async getSettlementShadowRows({ pageSize = 1000, retries = 3 } = {}) {
    if (!this.enabled) return [];
    const rows = [];
    const page = lastId => this.client
      .from('ml_features')
      .select('id, ticker, ts, label, collector_meta')
      .eq('signal_type', 'MARKET_SNAPSHOT_YES')
      .not('label', 'is', null)
      .not('collector_meta', 'is', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(pageSize);
    for (let lastId = 0; ;) {
      let { data, error } = await page(lastId);
      // Statement timeouts are intermittent under write load; retry the page with backoff.
      for (let attempt = 1; error && /statement timeout/i.test(error.message || '') && attempt <= retries; attempt++) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        ({ data, error } = await page(lastId));
      }
      if (error) throw new Error(`getSettlementShadowRows: ${error.message}`);
      if (!data || !data.length) break;
      for (const { id, ...r } of data) rows.push(r);
      lastId = data[data.length - 1].id;
      if (data.length < pageSize) break;
    }
    return rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  // Read-only: collector snapshots (5 s) for one market, oldest first. Uses the ticker index.
  async getCollectorSnapshots(ticker) {
    if (!this.enabled) return [];
    const { data, error } = await this.client
      .from('ml_features')
      .select('ts, collector_meta')
      .eq('ticker', ticker)
      .eq('signal_type', 'MARKET_SNAPSHOT_YES')
      .not('collector_meta', 'is', null)
      .order('ts', { ascending: true })
      .limit(1000);
    if (error) throw new Error(`getCollectorSnapshots(${ticker}): ${error.message}`);
    return data || [];
  }

  async upsertHistoricalStaging(rows) {
    if (!this.enabled || !rows?.length) return 0;
    const pageSize = 500;
    let written = 0;
    for (let i = 0; i < rows.length; i += pageSize) {
      const page = rows.slice(i, i + pageSize);
      const { error } = await this.client.from('ml_historical_staging').upsert(page, { onConflict: 'observation_id' });
      if (error) throw new Error(`historical staging upsert failed: ${error.message}`);
      written += page.length;
    }
    return written;
  }

  // ===== ML Predictions =====

  async logPrediction(prediction) {
    if (!this.enabled) return;
    const { error } = await this.client.from('ml_predictions').insert({
      ts: new Date().toISOString(),
      signal_id: prediction.signalId,
      model_version: prediction.modelVersion,
      confidence: prediction.confidence,
      predicted_outcome: prediction.predictedOutcome,
      features_hash: prediction.featuresHash,
    });
    if (error) console.error('[Supabase] logPrediction error:', error.message);
  }

  // ===== RAG Embeddings =====

  async storeEmbedding(text, embedding, metadata = {}) {
    if (!this.enabled) return;
    const { error } = await this.client.from('embeddings').insert({
      content: text,
      embedding, // pgvector expects an array of floats
      metadata,
      created_at: new Date().toISOString(),
    });
    if (error) console.error('[Supabase] storeEmbedding error:', error.message);
  }

  async searchSimilar(queryEmbedding, limit = 5) {
    if (!this.enabled) return [];
    // Uses pgvector similarity search via Supabase RPC
    const { data, error } = await this.client.rpc('match_embeddings', {
      query_embedding: queryEmbedding,
      match_count: limit,
    });
    if (error) { console.error('[Supabase] searchSimilar error:', error.message); return []; }
    return data || [];
  }

  // ===== Recent Signals for RAG Context =====

  async getRecentSignals(ticker, hours = 24) {
    if (!this.enabled) return [];
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const { data, error } = await this.client
      .from('signals')
      .select('*')
      .gte('ts', since)
      .order('ts', { ascending: false })
      .limit(50);
    if (error) return [];
    return data || [];
  }

  async getStrategyPerformance(days = 7) {
    if (!this.enabled) return {};
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await this.client
      .from('signals')
      .select('type, outcome_won, outcome_pnl, edge')
      .gte('ts', since)
      .not('outcome_won', 'is', null);
    if (error) return {};

    const stats = {};
    for (const s of (data || [])) {
      if (!stats[s.type]) stats[s.type] = { wins: 0, losses: 0, pnl: 0, totalEdge: 0, count: 0 };
      const st = stats[s.type];
      st.count++;
      if (s.outcome_won) st.wins++; else st.losses++;
      st.pnl += s.outcome_pnl || 0;
      st.totalEdge += s.edge || 0;
    }
    return stats;
  }
}

// Supabase SQL migrations for initial setup
SupabaseStore.MIGRATIONS = `
-- Bot state (single row, JSON blob)
CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signals (ML training data)
CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  price_cents INTEGER,
  edge REAL,
  model_prob REAL,
  contracts INTEGER,
  reason TEXT,
  executed BOOLEAN DEFAULT TRUE,
  blocked_reason TEXT,
  outcome_won BOOLEAN,
  outcome_pnl REAL,
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_id TEXT UNIQUE,
  client_order_id TEXT,
  signal_id BIGINT REFERENCES signals(id),
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  action TEXT NOT NULL,
  price_cents INTEGER,
  count INTEGER,
  status TEXT,
  fill_count INTEGER DEFAULT 0,
  taker_fill_cost INTEGER DEFAULT 0,
  taker_fees INTEGER DEFAULT 0,
  close_time BIGINT
);

-- Market snapshots
CREATE TABLE IF NOT EXISTS market_snapshots (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker TEXT NOT NULL,
  yes_bid REAL,
  yes_ask REAL,
  no_bid REAL,
  no_ask REAL,
  btc_price REAL,
  time_remaining_s REAL,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON market_snapshots(ticker);

-- ML features (for model training)
CREATE TABLE IF NOT EXISTS ml_features (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker TEXT,
  signal_type TEXT,
  observation_id TEXT UNIQUE,
  predicted_side TEXT,
  features JSONB NOT NULL,
  label INTEGER,
  settled_result TEXT,
  labeled_at TIMESTAMPTZ,
  signal_id BIGINT REFERENCES signals(id)
);
CREATE INDEX IF NOT EXISTS idx_ml_features_label ON ml_features(label);

-- ML predictions (feedback loop)
CREATE TABLE IF NOT EXISTS ml_predictions (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_id BIGINT REFERENCES signals(id),
  model_version TEXT,
  confidence REAL,
  predicted_outcome INTEGER,
  features_hash TEXT
);

-- RAG embeddings (pgvector)
-- Requires: CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS embeddings (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Similarity search function
CREATE OR REPLACE FUNCTION match_embeddings(query_embedding vector(1536), match_count INT DEFAULT 5)
RETURNS TABLE(id BIGINT, content TEXT, metadata JSONB, similarity REAL)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, e.content, e.metadata,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM embeddings e
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
`;

// Singleton
const store = new SupabaseStore();
module.exports = store;
