/**
 * MLDataCollector Skill
 *
 * Samples active KXBTC15M markets independently of trading decisions.
 * Each row is a canonical YES-outcome observation:
 *   label = NULL until Kalshi settles, then 1 for YES / 0 for NO.
 *
 * This collector never places, modifies, or closes orders.
 */
const BaseSkill = require('../../core/base-skill');
const mlPipeline = require('../../../lib/ml-pipeline');
const supabase = require('../../../lib/supabase');

class MLDataCollector extends BaseSkill {
  constructor() {
    super({
      name: 'ml-data-collector',
      description: 'Trade-independent KXBTC15M feature sampler with settlement-only labels',
      domain: 'analysis',
      capabilities: ['collect-ml-snapshots', 'label-settled-ml-markets'],
      dependencies: ['state-manager', 'kalshi-market-data', 'ml-signal-scorer'],
    });
    this.interval = null;
    this.running = false;
    this.cadenceMs = 5000;
    this.pendingTickers = new Set();
  }

  async initialize(context) {
    await super.initialize(context);
    const configured = Number(context.config.ML_COLLECT_INTERVAL_MS || process.env.ML_COLLECT_INTERVAL_MS);
    if (Number.isFinite(configured) && configured >= 1000) this.cadenceMs = configured;
  }

  async start() {
    await super.start();
    if (!supabase.enabled) {
      console.log('[MLCollector] Supabase disabled; collector idle');
      return;
    }
    await this._recoverPendingTickers();
    this.interval = setInterval(() => this._tick().catch(err => {
      console.error('[MLCollector] tick error:', err.message);
    }), this.cadenceMs);
    this.interval.unref?.();
    console.log(`[MLCollector] Sampling active markets every ${this.cadenceMs / 1000}s (trade-independent)`);
  }

  async handleTask(task) {
    if (task.action === 'collect-ml-snapshots') return this._collect();
    if (task.action === 'label-settled-ml-markets') return this._labelSettled();
    throw new Error(`Unknown action: ${task.action}`);
  }

  async _tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this._collect();
      await this._labelSettled();
    } finally {
      this.running = false;
    }
  }

  _marketContext(market, state) {
    const model = state.model || {};
    const stats = state.stats || {};
    return {
      btcPrice: state.btcPrice?.binance || 0,
      openPrice: state.marketOpenPrices?.[market.ticker] || 0,
      timeRemainingMs: Math.max(0, (market.closeTime || 0) - Date.now()),
      totalDurationMs: 900000,
      sigma: model.volatility || 0.0015,
      trend: model.trend || 'NEUTRAL',
      trendStrength: model.trendStrength || 0,
      trendROC: model.trendROC || 0,
      yesAsk: market.yesAsk || 0.5,
      noAsk: market.noAsk || 0.5,
      yesBid: market.yesBid || 0.5,
      noBid: market.noBid || 0.5,
      recentWinRate: stats.totalTrades > 0 ? stats.wins / stats.totalTrades : 0.5,
      recentPnL: stats.totalPnL || 0,
      streak: stats.streak || 0,
      balanceAvailable: state.balance?.available || 0,
    };
  }

  async _collect() {
    if (!supabase.enabled) return { collected: 0 };
    const state = this.context.registry.get('state-manager').botState;
    const markets = state.activeMarkets || [];
    const now = Date.now();
    let collected = 0;

    for (const market of markets) {
      if (!market?.ticker || !market.closeTime || market.closeTime <= now) continue;
      if (!state.btcPrice?.binance) continue;

      const modelProb = Number.isFinite(state.model?.impliedProbUp) ? state.model.impliedProbUp : 0.5;
      const yesAsk = Number.isFinite(market.yesAsk) && market.yesAsk > 0 ? market.yesAsk : 0.5;
      const signal = {
        type: 'DIRECTIONAL_YES_SNAPSHOT',
        ticker: market.ticker,
        side: 'yes',
        edge: (modelProb - yesAsk) * 100,
        modelProb,
        priceCents: Math.round(yesAsk * 100),
        contracts: 0,
      };
      const vector = mlPipeline.extractFeatures(signal, this._marketContext(market, state));
      const bucket = Math.floor(now / this.cadenceMs) * this.cadenceMs;
      const observationId = `market:${market.ticker}:${bucket}`;

      await supabase.logFeatures({
        observationId,
        ts: new Date(bucket).toISOString(),
        ticker: market.ticker,
        signalType: 'MARKET_SNAPSHOT_YES',
        predictedSide: 'yes',
        vector,
        label: null,
      });
      this.pendingTickers.add(market.ticker);
      collected++;
    }
    return { collected };
  }

  async _recoverPendingTickers() {
    const tickers = await supabase.getUnlabeledMarketTickers();
    for (const ticker of tickers) this.pendingTickers.add(ticker);
    if (tickers.length) console.log(`[MLCollector] Recovered ${tickers.length} unsettled market(s) from Supabase`);
  }

  async _labelSettled() {
    if (!supabase.enabled || this.pendingTickers.size === 0) return { labeledMarkets: 0 };
    const kalshi = this.context.registry.get('kalshi-market-data').getClient();
    let labeledMarkets = 0;

    for (const ticker of [...this.pendingTickers]) {
      try {
        const market = await kalshi.fetchMarket(ticker);
        const result = String(market?.result || '').toLowerCase();
        if (result !== 'yes' && result !== 'no') continue;
        await supabase.labelMarketObservations(ticker, result);
        this.pendingTickers.delete(ticker);
        labeledMarkets++;
        console.log(`[MLCollector] Settled ${ticker}=${result.toUpperCase()} — labeled snapshot observations`);
      } catch (err) {
        // 404/transient API errors are retried on a later collector tick.
      }
    }
    return { labeledMarkets };
  }

  async stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await super.stop();
  }
}

module.exports = MLDataCollector;
