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
const { settlementProbabilityForMarket } = require('../../../lib/settlement-model');

// v3.1: volatility/trend/model_prob are computed per market at snapshot time.
// Earlier collectors copied state.model, which freezes after TRADING_WINDOW,
// so FINAL-regime rows carried stale volatility/trend values.
const COLLECTOR_VERSION = 'live-collector-v3.1';

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

  _skill(name) {
    try { return this.context?.registry?.get(name) || null; } catch { return null; }
  }

  // Live, per-market inputs at snapshot time. Falls back to state.model only
  // when the feed/trend skills are unavailable (e.g. isolated tests).
  _liveInputs(market, state, now) {
    const model = state.model || {};
    const feed = this._skill('binance-price-feed')?.getFeed?.() || null;
    const trendData = this._skill('trend-analysis')?.getIndicator?.()?.getTrend?.() || null;
    const btcPrice = state.btcPrice?.binance || 0;
    const openPrice = state.marketOpenPrices?.[market.ticker] || 0;
    const durationMs = Number.isFinite(market.openTime) && market.closeTime > market.openTime ? market.closeTime - market.openTime : 900000;
    const sigma = feed ? feed.getRecentVolatility(durationMs / 1000) : (model.volatility || 0.0015);
    const live = Boolean(feed);
    let gbmProb = null;
    const probModel = this._skill('probability-model');
    if (feed && probModel && openPrice > 0 && btcPrice > 0) {
      gbmProb = probModel.calculateImpliedProbability(btcPrice, openPrice, Math.max(0, market.closeTime - now), durationMs, feed).probUp;
    }
    const settle = feed && btcPrice > 0 ? settlementProbabilityForMarket({ market, currentPrice: btcPrice, now, feed }) : null;
    return {
      live, sigma, gbmProb, settle,
      trend: trendData ? (trendData.trend || 'NEUTRAL') : (model.trend || 'NEUTRAL'),
      trendStrength: trendData ? (trendData.strength || 0) : (model.trendStrength || 0),
      trendROC: trendData ? (trendData.roc || 0) : (model.trendROC || 0),
    };
  }

  _marketContext(market, state, live) {
    const stats = state.stats || {};
    return {
      btcPrice: state.btcPrice?.binance || 0,
      openPrice: state.marketOpenPrices?.[market.ticker] || 0,
      timeRemainingMs: Math.max(0, (market.closeTime || 0) - Date.now()),
      totalDurationMs: 900000,
      sigma: live.sigma,
      trend: live.trend,
      trendStrength: live.trendStrength,
      trendROC: live.trendROC,
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

      const live = this._liveInputs(market, state, now);
      const modelProb = live.live
        ? (Number.isFinite(live.gbmProb) ? live.gbmProb : 0.5)
        : (Number.isFinite(state.model?.impliedProbUp) ? state.model.impliedProbUp : 0.5);
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
      const vector = mlPipeline.extractFeatures(signal, this._marketContext(market, state, live));
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
        collectorMeta: {
          collector_version: COLLECTOR_VERSION,
          live_inputs: live.live,
          gbm_p: live.gbmProb,
          settlement_p: live.settle ? live.settle.probUp : null,
          settlement_strike: live.settle ? live.settle.strike : null,
          floor_strike: Number.isFinite(market.floorStrike) ? market.floorStrike : null,
          strike_basis: live.settle ? live.settle.basis : null,
          final_window_samples: live.settle ? live.settle.observedSamples : null,
          kalshi_yes_ask: market.yesAsk ?? null,
          kalshi_yes_bid: market.yesBid ?? null,
          time_remaining_s: Math.max(0, (market.closeTime - now) / 1000),
        },
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
