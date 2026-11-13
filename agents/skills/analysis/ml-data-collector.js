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
const { CfIndexPoller } = require('../../../lib/cf-index');
const { feedsFrom, marketPriceInputs } = require('../../../lib/market-prices');

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
    // Official CF Benchmarks BRTI (shadow): logged beside each snapshot.
    if (String(this.context?.config?.CF_INDEX_ENABLED ?? process.env.CF_INDEX_ENABLED ?? 'true') !== 'false') {
      try {
        const client = this.context.registry.get('kalshi-market-data')?.getClient?.();
        if (client) { this.cfIndex = new CfIndexPoller({ client }); this.cfIndex.start(); }
      } catch (err) { console.warn('[MLCollector] CF index feed not started:', err.message); }
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
    const binanceFeed = this._skill('binance-price-feed')?.getFeed?.() || null;
    const trendData = this._skill('trend-analysis')?.getIndicator?.()?.getTrend?.() || null;
    const btcPrice = state.btcPrice?.binance || 0;
    // Opening/current price pair from one feed (composite USD preferred, else Binance).
    const px = this.context?.registry ? marketPriceInputs(market, state, feedsFrom(this.context.registry)) : null;
    const feed = px?.feed || binanceFeed;
    const durationMs = Number.isFinite(market.openTime) && market.closeTime > market.openTime ? market.closeTime - market.openTime : 900000;
    const sigma = feed ? feed.getRecentVolatility(durationMs / 1000) : (model.volatility || 0.0015);
    const live = Boolean(feed);
    let gbmProb = null;
    const probModel = this._skill('probability-model');
    if (px && probModel) {
      gbmProb = probModel.calculateImpliedProbability(px.currentPrice, px.openPrice, Math.max(0, market.closeTime - now), durationMs, px.feed).probUp;
    }
    const settle = binanceFeed && btcPrice > 0 ? settlementProbabilityForMarket({ market, currentPrice: btcPrice, now, feed: binanceFeed }) : null;
    const brti = probModel?.calculateReferenceSettlementProbability?.(market, now) || null;
    return {
      live, sigma, gbmProb, settle, brti, px,
      trend: trendData ? (trendData.trend || 'NEUTRAL') : (model.trend || 'NEUTRAL'),
      trendStrength: trendData ? (trendData.strength || 0) : (model.trendStrength || 0),
      trendROC: trendData ? (trendData.roc || 0) : (model.trendROC || 0),
    };
  }

  _marketContext(market, state, live) {
    const stats = state.stats || {};
    return {
      btcPrice: live.px ? live.px.currentPrice : (state.btcPrice?.binance || 0),
      openPrice: live.px ? live.px.openPrice : (state.marketOpenPrices?.[market.ticker] || 0),
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
      const live = this._liveInputs(market, state, now);
      if (!live.px && !state.btcPrice?.binance) continue;
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
          open_price_source: live.px ? live.px.source : null,
          settlement_p: live.settle ? live.settle.probUp : null,
          settlement_strike: live.settle ? live.settle.strike : null,
          floor_strike: Number.isFinite(market.floorStrike) ? market.floorStrike : null,
          strike_basis: live.settle ? live.settle.basis : null,
          brti_p: live.brti ? live.brti.probUp : null,
          reference_price: live.brti ? live.brti.referencePrice : null,
          reference_bias: live.brti ? live.brti.bias : null,
          ...this._cfMeta(now),
          ...this._polyMeta(market, now),
          final_window_samples: live.settle ? live.settle.observedSamples : null,
          kalshi_yes_ask: market.yesAsk ?? null,
          kalshi_yes_bid: market.yesBid ?? null,
          // Top-of-book sizes (contracts). NO bid size = YES ask size and vice versa.
          kalshi_yes_bid_size: Number.isFinite(market.yesBidSize) ? market.yesBidSize : null,
          kalshi_yes_ask_size: Number.isFinite(market.yesAskSize) ? market.yesAskSize : null,
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

  _cfMeta(now) {
    if (!this.cfIndex) return {};
    const c = this.cfIndex.snapshot(now);
    return { cf_brti: c.value, cf_brti_age_ms: c.time ? now - c.time : null, cf_brti_avg60: c.avg60, cf_brti_avg60_n: c.avg60Samples, cf_error: c.error };
  }

  // Shadow-only cross-market data: the matching Polymarket "Bitcoin Up or Down" 15-minute
  // market (resolves on the Chainlink BTC/USD stream, end vs start price — not CF BRTI).
  // The CLOB /price "buy"/"sell" semantics are logged as lo/hi (min/max) so no bid/ask
  // assumption is baked in. Never used for trading here.
  _polyMeta(market, now) {
    const poly = this.context.registry.get('polymarket-price-feed');
    const d = poly?.getCachedPrice?.(market.closeTime);
    const ok = d && [d.upBuy, d.upSell].every(Number.isFinite);
    return {
      poly_up_lo: ok ? Math.min(d.upBuy, d.upSell) : null,
      poly_up_hi: ok ? Math.max(d.upBuy, d.upSell) : null,
      poly_age_ms: d && Number.isFinite(d.fetchedAt) ? now - d.fetchedAt : null,
      poly_slug: d?.slug ?? null,
    };
  }

  async stop() {
    this.cfIndex?.stop();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await super.stop();
  }
}

module.exports = MLDataCollector;
