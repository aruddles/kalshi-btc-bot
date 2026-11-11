/**
 * SignalGenerator Skill
 *
 * Generates trading signals by composing probability model, trend analysis,
 * and cross-market price data. This is the analysis "brain" that identifies
 * trading opportunities across three strategies:
 *
 *  1. DIRECTIONAL — Binance spot divergence from Kalshi contract price
 *  2. POLY_ARB    — Polymarket fair value exceeds Kalshi ask
 *  3. DUAL_SIDE   — YES + NO ask < $1 (guaranteed profit)
 *
 * Also generates take-profit signals for open positions.
 *
 * Capabilities: generate-signals, generate-take-profit-signals
 */

const BaseSkill = require('../../core/base-skill');
const { estimateTakerFeeDollars, expectedValuePerContract, sizeContracts } = require('../../../lib/kalshi-economics');

class SignalGenerator extends BaseSkill {
  constructor() {
    super({
      name: 'signal-generator',
      description: 'Generates trading signals from market data, probability model, and trend analysis',
      domain: 'analysis',
      capabilities: ['generate-signals', 'generate-take-profit-signals'],
      dependencies: ['state-manager', 'binance-price-feed', 'polymarket-price-feed', 'probability-model', 'trend-analysis'],
    });

    // Configured in initialize()
    this.minEdge = 10.0;
    this.minDivergence = 10.0;
    this.kellyFraction = 0.25;
    this.useKelly = true;
    this.maxPositionSize = 25;
    this.tradingWindow = 4 * 60 * 1000;
    this.minContractPrice = 0.48;
    this.maxContractPrice = 0.88;
    this.maxQuoteAgeMs = 10000;
    this.paperPlus = false;
  }

  async initialize(context) {
    await super.initialize(context);
    const config = context.config;

    this.minEdge = config.MIN_EDGE || 10.0;
    this.minDivergence = config.MIN_DIVERGENCE || 10.0;
    this.kellyFraction = config.KELLY_FRACTION ?? 0.08;
    this.useKelly = config.USE_KELLY_SIZING !== false;
    this.maxPositionSize = config.MAX_POSITION_SIZE || 25;
    this.tradingWindow = (config.TRADING_WINDOW || 4) * 60 * 1000;
    this.minContractPrice = (config.MIN_CONTRACT_PRICE ?? 35) / 100;
    this.maxContractPrice = (config.MAX_CONTRACT_PRICE ?? 65) / 100;

    // PAPER+ is deliberately more permissive, but can never place a live order because
    // KalshiClient treats only exact TRADING_MODE=live as real execution. Keep normal
    // paper/live thresholds untouched for apples-to-apples comparison.
    this.paperPlus = String(config.TRADING_MODE || '').toLowerCase() === 'paper+';
    if (this.paperPlus) {
      this.minEdge = Number(config.PAPER_PLUS_MIN_EDGE ?? 3.0);
      this.minDivergence = Number(config.PAPER_PLUS_MIN_DIVERGENCE ?? 4.0);
      this.kellyFraction = Number(config.PAPER_PLUS_KELLY_FRACTION ?? 0.20);
      this.maxPositionSize = Number(config.PAPER_PLUS_MAX_POSITION_SIZE ?? this.maxPositionSize);
      this.tradingWindow = Number(config.PAPER_PLUS_TRADING_WINDOW ?? 10) * 60 * 1000;
      this.minContractPrice = Number(config.PAPER_PLUS_MIN_CONTRACT_PRICE ?? 25) / 100;
      this.maxContractPrice = Number(config.PAPER_PLUS_MAX_CONTRACT_PRICE ?? 75) / 100;
      console.log(`[SignalGenerator] PAPER+ active: divergence>=${this.minDivergence}% edge>=${this.minEdge}% range=${(this.minContractPrice*100).toFixed(0)}-${(this.maxContractPrice*100).toFixed(0)}c window=${Math.round(this.tradingWindow/60000)}m`);
    }
  }

  _isPaperPlus() {
    const client = this.context?.registry?.get('kalshi-market-data')?.getClient?.();
    return (client?.tradingMode || this.context?.config?.TRADING_MODE) === 'paper+';
  }

  _applyModeThresholds() {
    const config = this.context.config;
    const plus = this._isPaperPlus();
    if (plus === this.paperPlus) return;
    this.paperPlus = plus;
    this.minEdge = config.MIN_EDGE || 10.0;
    this.minDivergence = config.MIN_DIVERGENCE || 10.0;
    this.kellyFraction = config.KELLY_FRACTION ?? 0.08;
    this.maxPositionSize = config.MAX_POSITION_SIZE || 25;
    this.tradingWindow = (config.TRADING_WINDOW || 4) * 60 * 1000;
    this.minContractPrice = (config.MIN_CONTRACT_PRICE ?? 35) / 100;
    this.maxContractPrice = (config.MAX_CONTRACT_PRICE ?? 65) / 100;
    if (plus) {
      this.minEdge = Number(config.PAPER_PLUS_MIN_EDGE ?? 3.0);
      this.minDivergence = Number(config.PAPER_PLUS_MIN_DIVERGENCE ?? 4.0);
      this.kellyFraction = Number(config.PAPER_PLUS_KELLY_FRACTION ?? 0.20);
      this.maxPositionSize = Number(config.PAPER_PLUS_MAX_POSITION_SIZE ?? this.maxPositionSize);
      this.tradingWindow = Number(config.PAPER_PLUS_TRADING_WINDOW ?? 10) * 60 * 1000;
      this.minContractPrice = Number(config.PAPER_PLUS_MIN_CONTRACT_PRICE ?? 25) / 100;
      this.maxContractPrice = Number(config.PAPER_PLUS_MAX_CONTRACT_PRICE ?? 75) / 100;
    }
  }

  async handleTask(task) {
    this._applyModeThresholds();
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'generate-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const signals = this._generateSignals(markets, state);
        return { signals };
      }

      case 'generate-take-profit-signals': {
        const markets = task.params?.markets || state.activeMarkets;
        const takeProfitSignals = this._generateTakeProfitSignals(state.openPositions, markets);
        return { takeProfitSignals };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  _generateSignals(kalshiMarkets, state) {
    const signals = [];
    const now = Date.now();
    const btcPrice = state.btcPrice.binance;
    if (!btcPrice) return signals;

    const probModel = this.context.registry.get('probability-model');
    const trendSkill = this.context.registry.get('trend-analysis');
    const polySkill = this.context.registry.get('polymarket-price-feed');
    const binanceFeed = this.context.registry.get('binance-price-feed').getFeed();

    for (const market of kalshiMarkets) {
      const timeRemaining = market.closeTime - now;
      const totalDuration = market.closeTime - market.openTime;
      const timeSinceOpen = now - market.openTime;

      if (timeSinceOpen > this.tradingWindow || timeRemaining < 30000) continue;

      // Skip a market whose latest refresh failed: its quotes are stale.
      if (market.refreshedAt !== undefined && now - market.refreshedAt > this.maxQuoteAgeMs) continue;

      const openPrice = state.marketOpenPrices[market.ticker];
      const referenceMeta = state.marketOpenPriceMeta?.[market.ticker];
      if (!openPrice || !referenceMeta || referenceMeta.source !== 'binance_at_market_open' || Math.abs(referenceMeta.timestamp - market.openTime) > 2500) continue;
      if (!market.yesAsk || !market.noAsk) continue;

      const yesInRange = market.yesAsk >= this.minContractPrice && market.yesAsk <= this.maxContractPrice;
      const noInRange = market.noAsk >= this.minContractPrice && market.noAsk <= this.maxContractPrice;

      // Get Polymarket cross-reference
      const poly = polySkill.getCachedPrice(market.closeTime);

      // Calculate model probability
      const legacyProb = probModel.calculateImpliedProbability(btcPrice, openPrice, timeRemaining, totalDuration, binanceFeed);
      // Settlement-aware models are always computed (shadow). One drives trading only when
      // PROB_MODEL=settlement_avg (Binance strike proxy) or settlement_brti (Kalshi
      // floor_strike + composite USD feed); if it is unavailable the market is skipped.
      const settle = probModel.calculateSettlementProbability?.(market, btcPrice, binanceFeed, now) || null;
      const brti = probModel.calculateReferenceSettlementProbability?.(market, now) || null;
      const probModelName = String(this.context.config.PROB_MODEL || 'gbm_point');
      const chosen = probModelName === 'settlement_avg' ? settle : probModelName === 'settlement_brti' ? brti : null;
      if (['settlement_avg', 'settlement_brti'].includes(probModelName) && !chosen) continue;
      const prob = chosen ? { ...legacyProb, probUp: chosen.probUp, probDown: chosen.probDown } : legacyProb;

      // Get trend data
      const trendData = trendSkill.getIndicator() ? trendSkill.getIndicator().getTrend() : {};

      const feeRateDiag = this.context.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
      const feeMultDiag = market.feeMultiplier ?? 1;
      const candidatesDiag = [
        { side:'yes', probability:prob.probUp, ask:market.yesAsk },
        { side:'no', probability:prob.probDown, ask:market.noAsk },
      ].filter(x => Number.isFinite(x.ask) && x.ask > 0 && x.ask < 1)
       .map(x => ({...x, ev: expectedValuePerContract(x.probability, x.ask, estimateTakerFeeDollars(x.ask,1,feeRateDiag,feeMultDiag))*100}))
       .sort((a,b)=>b.ev-a.ev);
      const bestDiag = candidatesDiag[0];
      if (bestDiag) {
        const mk = (name, minEdge, minDiv, minPrice, maxPrice, windowMin) => {
          const gates=[
            {name:'Model edge',value:`${bestDiag.ev>=0?'+':''}${bestDiag.ev.toFixed(1)}%`,pass:bestDiag.ev>=minEdge},
            {name:'Divergence',value:`${bestDiag.ev>=0?'+':''}${bestDiag.ev.toFixed(1)}% / need ${minDiv.toFixed(1)}%`,pass:bestDiag.ev>=minDiv},
            {name:'Price',value:`${Math.round(bestDiag.ask*100)}c / ${minPrice}-${maxPrice}c`,pass:bestDiag.ask*100>=minPrice&&bestDiag.ask*100<=maxPrice},
            {name:'Time remaining',value:`${Math.max(0,Math.ceil(timeRemaining/1000))}s`,pass:timeSinceOpen<=windowMin*60000&&timeRemaining>=30000},
            {name:'Orderbook',value:(market.refreshedAt===undefined||now-market.refreshedAt<=this.maxQuoteAgeMs)?'Fresh':'Stale',pass:market.refreshedAt===undefined||now-market.refreshedAt<=this.maxQuoteAgeMs},
          ]; return {side:bestDiag.side,eligible:gates.every(g=>g.pass),gates};
        };
        state.updateIntent({decisionDiagnostics:{
          paper:mk('PAPER',Number(this.context.config.MIN_EDGE||10),Number(this.context.config.MIN_DIVERGENCE||10),Number(this.context.config.MIN_CONTRACT_PRICE??35),Number(this.context.config.MAX_CONTRACT_PRICE??65),Number(this.context.config.TRADING_WINDOW||4)),
          paperPlus:mk('PAPER+',Number(this.context.config.PAPER_PLUS_MIN_EDGE??3),Number(this.context.config.PAPER_PLUS_MIN_DIVERGENCE??4),Number(this.context.config.PAPER_PLUS_MIN_CONTRACT_PRICE??25),Number(this.context.config.PAPER_PLUS_MAX_CONTRACT_PRICE??75),Number(this.context.config.PAPER_PLUS_TRADING_WINDOW??10))
        }});
      }

      // Update state model for UI
      state.updateModel({
        impliedProbUp: prob.probUp,
        impliedProbDown: prob.probDown,
        probModel: chosen ? probModelName : 'gbm_point',
        gbmProbUp: legacyProb.probUp,
        settlementProbUp: settle ? settle.probUp : null,
        brtiProbUp: brti ? brti.probUp : null,
        referencePrice: brti ? brti.referencePrice : null,
        floorStrike: Number.isFinite(market.floorStrike) ? market.floorStrike : null,
        strikeBasis: settle ? settle.basis : null,
        spotMove: prob.move,
        spotMovePct: prob.movePct,
        timeRemaining: timeRemaining / 1000,
        targetPrice: openPrice,
        volatility: prob.sigma,
        trend: trendData.trend || 'NEUTRAL',
        trendStrength: trendData.strength || 0,
        trendROC: trendData.roc || 0,
        trendWarmup: trendData.warmup || false,
      });

      // All entry economics use Kalshi's executable ask and a fee estimate.
      const feeRate = this.context.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
      const feeMultiplier = market.feeMultiplier ?? 1;
      const emitDirectional = (side, probability, ask, askCents, _trendMultiplier, trendLabel) => {
        if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return;
        const fee = estimateTakerFeeDollars(ask, 1, feeRate, feeMultiplier);
        const netEv = expectedValuePerContract(probability, ask, fee);
        const adjustedEdge = netEv * 100;
        const inRange = ask >= this.minContractPrice && ask <= this.maxContractPrice;
        if (adjustedEdge < this.minDivergence || !inRange) return;
        const contracts = this.useKelly
          ? sizeContracts(probability, ask, state.balance.available, this.maxPositionSize, feeRate, feeMultiplier, this.kellyFraction)
          : Math.floor(Math.min(state.balance.available, this.maxPositionSize) / (ask + fee));
        if (contracts < 1) return;
        signals.push({
          type: side === 'yes' ? 'DIRECTIONAL_YES' : 'DIRECTIONAL_NO', ticker: market.ticker, side,
          priceCents: askCents || Math.round(ask * 100), priceDecimal: ask,
          edge: adjustedEdge, expectedValue: netEv, estimatedEntryFee: estimateTakerFeeDollars(ask, contracts, feeRate, feeMultiplier),
          contracts, modelProb: probability,
          reason: `Net EV ${(netEv * 100).toFixed(2)}¢/contract | model ${(probability * 100).toFixed(1)}% vs executable ask ${(ask * 100).toFixed(1)}% | 1H: ${trendLabel}`,
          closeTime: market.closeTime, executionMode: 'taker',
        });
      };
      const trendMultYes = trendSkill.getTrendMultiplier('yes');
      const trendMultNo = trendSkill.getTrendMultiplier('no');
      const currentTrend = trendData.trend || 'NEUTRAL';
      emitDirectional('yes', prob.probUp, market.yesAsk, market.yesAskCents, trendMultYes, currentTrend);
      emitDirectional('no', prob.probDown, market.noAsk, market.noAskCents, trendMultNo, currentTrend);

      // Cross-venue signal uses Polymarket's executable sell quote (bid), not midpoint.
      // It remains a probability proxy and is only eligible when both feeds are fresh.
      if (poly && Number.isFinite(poly.upSell) && Date.now() - poly.fetchedAt <= 5000) {
        const ask = market.yesAsk;
        const fee = estimateTakerFeeDollars(ask, 1, feeRate, feeMultiplier);
        const netEv = expectedValuePerContract(poly.upSell, ask, fee);
        if (netEv * 100 >= this.minEdge * 1.5 && ask >= this.minContractPrice && ask <= this.maxContractPrice) {
          const contracts = this.useKelly
            ? sizeContracts(poly.upSell, ask, state.balance.available, this.maxPositionSize, feeRate, feeMultiplier, this.kellyFraction)
            : Math.floor(Math.min(state.balance.available, this.maxPositionSize) / (ask + fee));
          if (contracts > 0) signals.push({
            type: 'POLY_ARB_YES', ticker: market.ticker, side: 'yes',
            priceCents: market.yesAskCents || Math.round(ask * 100), priceDecimal: ask,
            edge: netEv * 100, expectedValue: netEv,
            estimatedEntryFee: estimateTakerFeeDollars(ask, contracts, feeRate, feeMultiplier),
            contracts, modelProb: poly.upSell,
            reason: `Poly executable bid ${(poly.upSell * 100).toFixed(1)}% vs Kalshi ask ${(ask * 100).toFixed(1)}%; fee-adjusted EV ${(netEv * 100).toFixed(2)}¢/contract`,
            closeTime: market.closeTime, executionMode: 'taker',
          });
        }
      }

      // Dual-side entry is disabled until the venue supports paired atomic execution.

    }

    signals.sort((a, b) => b.edge - a.edge);
    return signals;
  }

  _generateTakeProfitSignals(openPositions, kalshiMarkets) {
    const signals = [];

    for (const pos of openPositions) {
      const market = kalshiMarkets.find(m => m.ticker === pos.ticker);
      if (!market) continue;

      const now = Date.now();
      const timeRemaining = pos.closeTime - now;
      if (timeRemaining < 30000) continue;

      const currentValue = pos.side === 'yes' ? market.yesBid : market.noBid;
      // Effective entry = price paid + entry fee per contract. A position with no
      // usable entry price (e.g. one we could not price) is never auto-sold: with a
      // zero entry the gain below would be infinite and it would be dumped instantly.
      const held = pos.filledContracts || pos.contracts;
      const entryPaid = pos.priceDecimal;
      if (!(entryPaid > 0 && entryPaid < 1) || !(held > 0)) continue;
      const entryFeePerContract = pos.totalCost > 0 ? Math.max(0, pos.totalCost / held - entryPaid) : 0;
      const entryPrice = entryPaid + entryFeePerContract;

      if (!currentValue || currentValue <= 0) continue;

      // What we would actually receive after the exit fee.
      const feeRate = this.context.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
      const exitFee = estimateTakerFeeDollars(currentValue, 1, feeRate, market.feeMultiplier ?? 1);
      const netValue = currentValue - exitFee;
      if (!Number.isFinite(netValue)) continue;

      const profitPct = ((netValue - entryPrice) / entryPrice) * 100;
      const maxGain = 1 - entryPrice;
      const gainFraction = maxGain > 0 ? (netValue - entryPrice) / maxGain : 0;

      let shouldExit = netValue > entryPrice && (profitPct > 15 || gainFraction > 0.5);
      let exitPolicy = 'baseline';

      if (this.paperPlus) {
        // PAPER+ intentionally holds winners longer early in the market, then becomes
        // progressively more willing to bank profit as settlement approaches. This
        // avoids a momentary early bid spike automatically ending a strong position.
        const secs = timeRemaining / 1000;
        let minProfitPct;
        let minGainFraction;
        if (secs > 300) {          // >5m left: demand a major repricing
          minProfitPct = 35; minGainFraction = 0.75;
        } else if (secs > 120) {   // 2-5m left
          minProfitPct = 25; minGainFraction = 0.60;
        } else {                   // 30s-2m left
          minProfitPct = 18; minGainFraction = 0.45;
        }
        shouldExit = netValue > entryPrice && (profitPct >= minProfitPct || gainFraction >= minGainFraction);
        exitPolicy = `paper+ ${Math.round(secs)}s left threshold=${minProfitPct}%/${Math.round(minGainFraction*100)}% max-gain`;
      }

      if (shouldExit) {
        signals.push({
          type: 'TAKE_PROFIT', orderId: pos.orderId, ticker: pos.ticker,
          side: pos.side, sellPriceCents: Math.round(currentValue * 100),
          sellPriceDecimal: currentValue,
          contracts: pos.filledContracts || pos.contracts,
          profitPct, gainFraction, exitPolicy,
          reason: `Take profit (${exitPolicy}): bought@${(entryPrice * 100).toFixed(0)}c sell@${(currentValue * 100).toFixed(0)}c (+${profitPct.toFixed(1)}%)`,
        });
      }
    }

    return signals;
  }
}

module.exports = SignalGenerator;
