/**
 * UsdReferenceFeed Skill
 *
 * Composite BTC/USD price from Coinbase, Kraken and Bitstamp: a proxy for the
 * CF Benchmarks BRTI index that KXBTC15M settles on. Also tracks, per market,
 * how closely this feed and Binance reproduce Kalshi's official strike.
 *
 * Capabilities: get-reference-price, get-reference-status
 */

const BaseSkill = require('../../core/base-skill');
const UsdReferenceFeed = require('../../../bot/usd-reference-feed');
const { StrikeTracker } = require('../../../lib/reference-price');

class UsdReferenceFeedSkill extends BaseSkill {
  constructor() {
    super({
      name: 'usd-reference-feed',
      description: 'Composite BTC/USD (Coinbase, Kraken, Bitstamp) as a BRTI proxy',
      domain: 'market-data',
      capabilities: ['get-reference-price', 'get-reference-status'],
      dependencies: ['state-manager'],
    });
    this.feed = null;
    this.tracker = new StrikeTracker();
    this.trackTimer = null;
  }

  async initialize(context) {
    await super.initialize(context);
    this.feed = new UsdReferenceFeed();
  }

  async start() {
    await super.start();
    if (this.context.config.USD_REFERENCE_ENABLED === false) return;
    this.feed.start();
    this.trackTimer = setInterval(() => this.observeMarkets(), 5000);
    this.trackTimer.unref?.();
  }

  async stop() {
    clearInterval(this.trackTimer);
    this.trackTimer = null;
    this.feed?.stop();
    await super.stop();
  }

  getFeed() { return this.feed; }

  // Median (feed - BRTI) error over recent markets; 0 until 20 markets are measured.
  getBias() { return this.tracker.referenceBias(); }

  observeMarkets() {
    try {
      const state = this.context.registry.get('state-manager').botState;
      const binance = this.context.registry.get('binance-price-feed')?.getFeed?.();
      this.tracker.observe(state.activeMarkets, { reference: this.feed.priceHistory, binance: binance?.priceHistory || [] });
    } catch (_) { /* registry still warming */ }
  }

  getStatus() {
    if (!this.feed) return { healthy: false, running: false };
    return { ...this.feed.getStatus(), running: this.feed.running, bias: this.getBias(), strikeAccuracy: this.tracker.summary() };
  }

  async handleTask(task) {
    switch (task.action) {
      case 'get-reference-price': return { price: this.feed.getPrice(), healthy: this.feed.isHealthy() };
      case 'get-reference-status': return this.getStatus();
      default: throw new Error(`Unknown action: ${task.action}`);
    }
  }
}

module.exports = UsdReferenceFeedSkill;
