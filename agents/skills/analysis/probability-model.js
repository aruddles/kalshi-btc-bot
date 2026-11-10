/**
 * ProbabilityModel Skill
 *
 * Calculates implied probability of BTC UP/DOWN using a normal distribution
 * model calibrated to realized volatility from the Binance feed.
 *
 * Capabilities: calculate-probability, kelly-size
 */

const BaseSkill = require('../../core/base-skill');

class ProbabilityModel extends BaseSkill {
  constructor() {
    super({
      name: 'probability-model',
      description: 'Normal distribution CDF model for BTC UP/DOWN probability estimation',
      domain: 'analysis',
      capabilities: ['calculate-probability', 'kelly-size'],
      dependencies: ['binance-price-feed', 'state-manager'],
    });
  }

  async initialize(context) {
    await super.initialize(context);
  }

  async handleTask(task) {
    switch (task.action) {
      case 'calculate-probability': {
        const { currentPrice, openPrice, timeRemainingMs, totalDurationMs } = task.params || {};
        const binanceFeed = this.context.registry.get('binance-price-feed').getFeed();
        return this.calculateImpliedProbability(currentPrice, openPrice, timeRemainingMs, totalDurationMs, binanceFeed);
      }

      case 'kelly-size': {
        const { probability, price, feePerContract = 0 } = task.params || {};
        const config = this.context.config;
        const kellyFraction = config.KELLY_FRACTION ?? 0.08;
        return { size: this.kellySize(probability, price, feePerContract, kellyFraction) };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  // Normal CDF approximation (Abramowitz & Stegun)
  // Authoritative implementation: lib/normal.js (v3.1 fix).
  normalCDF(x) {
    return require('../../../lib/normal').normalCdf(x);
  }

  calculateImpliedProbability(currentPrice, openPrice, timeRemainingMs, totalDurationMs, binanceFeed) {
    if (!currentPrice || !openPrice || openPrice === 0) {
      return { probUp: 0.5, probDown: 0.5 };
    }

    const move = (currentPrice - openPrice) / openPrice;
    const timeRemaining = Math.max(0.001, timeRemainingMs / totalDurationMs);
    const totalDurationSec = totalDurationMs / 1000;
    const sigma = binanceFeed.getRecentVolatility(totalDurationSec);
    const remainingSigma = sigma * Math.sqrt(timeRemaining);

    if (remainingSigma < 0.00001) {
      return { probUp: move > 0 ? 0.99 : 0.01, probDown: move > 0 ? 0.01 : 0.99 };
    }

    const z = move / remainingSigma;
    const probUp = this.normalCDF(z);
    const probDown = 1 - probUp;

    return {
      probUp: Math.max(0.01, Math.min(0.99, probUp)),
      probDown: Math.max(0.01, Math.min(0.99, probDown)),
      move,
      movePct: move * 100,
      z,
      sigma,
      remainingSigma,
    };
  }

  // Settlement-aware model (lib/settlement-model). Returns null when the
  // pre-open reference minute was not observed; callers must fail safe.
  calculateSettlementProbability(market, currentPrice, binanceFeed, now = Date.now()) {
    const { settlementProbabilityForMarket } = require('../../../lib/settlement-model');
    return settlementProbabilityForMarket({ market, currentPrice, now, feed: binanceFeed });
  }

  kellySize(probability, executablePrice, feePerContract = 0, kellyFraction = 0.08) {
    const { kellyBankrollFraction } = require('../../../lib/kalshi-economics');
    return kellyBankrollFraction(probability, executablePrice, feePerContract, kellyFraction);
  }
}

module.exports = ProbabilityModel;
