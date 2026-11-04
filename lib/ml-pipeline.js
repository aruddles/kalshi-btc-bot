/**
 * ML Pipeline — Feature extraction, model training, and prediction
 * for signal quality scoring.
 *
 * Architecture:
 *   1. Feature Extraction: Convert market state → numeric feature vector
 *   2. Training: Gradient-boosted decision stumps (lightweight, no TensorFlow)
 *   3. Prediction: Score each signal with confidence [0, 1]
 *   4. RAG Context: Retrieve similar historical trades for context-aware decisions
 *
 * The ML model learns which signals actually win by looking at:
 *   - Market microstructure (spread, depth, time-to-close)
 *   - Model confidence (probability, edge, z-score)
 *   - Trend alignment (EMA crossover, ROC)
 *   - Volatility regime (realized vol, vol-of-vol)
 *   - Historical performance (strategy win rate, recent streak)
 *
 * Storage: Supabase (Postgres + pgvector for RAG embeddings)
 */

const supabase = require('./supabase');

class MLPipeline {
  constructor() {
    this.modelVersion = 'v1.0';
    this.trees = [];          // Trained decision stumps
    this.featureNames = [];
    this.trained = false;
    this.trainingSize = 0;
    this.validationSize = 0;
    this.validationAccuracy = null;
    this.validationBrier = null;

    // Feature normalization params (learned during training)
    this.featureMeans = [];
    this.featureStds = [];
  }

  // ===== Feature Extraction =====

  /**
   * Extract a numeric feature vector from a signal + market context.
   * Returns a flat array of numbers suitable for ML model input.
   */
  extractFeatures(signal, marketContext) {
    const {
      btcPrice = 0, openPrice = 0, timeRemainingMs = 0, totalDurationMs = 900000,
      sigma = 0.0015, trend = 'NEUTRAL', trendStrength = 0, trendROC = 0,
      yesAsk = 0.5, noAsk = 0.5, yesBid = 0.5, noBid = 0.5,
      recentWinRate = 0.5, recentPnL = 0, streak = 0,
      balanceAvailable = 100,
    } = marketContext;

    const move = openPrice > 0 ? (btcPrice - openPrice) / openPrice : 0;
    const timeRemaining = totalDurationMs > 0 ? timeRemainingMs / totalDurationMs : 0;
    const spread = yesAsk - yesBid;
    const noSpread = noAsk - noBid;
    const combinedAsk = yesAsk + noAsk;
    const isDirectional = signal.type.startsWith('DIRECTIONAL');
    const isPolyArb = signal.type.startsWith('POLY_ARB');
    const isDualSide = signal.type.startsWith('DUAL_SIDE');
    const isBuyYes = signal.side === 'yes';

    // Trend alignment
    const trendAligned = (isBuyYes && trend === 'BULLISH') || (!isBuyYes && trend === 'BEARISH');
    const trendCounter = (isBuyYes && trend === 'BEARISH') || (!isBuyYes && trend === 'BULLISH');

    const features = [
      // Price movement features
      move * 1000,                              // 0: spot move (scaled)
      Math.abs(move) * 1000,                    // 1: absolute move magnitude
      move > 0 ? 1 : 0,                         // 2: move direction (binary)

      // Time features
      timeRemaining,                             // 3: fraction of time remaining
      Math.max(0, 1 - timeRemaining) * 100,     // 4: time elapsed (%)

      // Volatility features
      sigma * 1000,                              // 5: realized volatility (scaled)
      sigma > 0.002 ? 1 : 0,                    // 6: high-vol regime flag

      // Signal features
      signal.edge,                               // 7: signal edge (%)
      signal.modelProb,                          // 8: model probability
      signal.priceCents / 100,                   // 9: contract price (decimal)
      signal.contracts,                          // 10: position size (contracts)

      // Market microstructure
      spread * 100,                              // 11: YES bid-ask spread (%)
      noSpread * 100,                            // 12: NO bid-ask spread (%)
      combinedAsk * 100,                         // 13: combined ask cost
      (1 - combinedAsk) * 100,                  // 14: dual-side profit margin

      // Strategy type (one-hot)
      isDirectional ? 1 : 0,                     // 15: is directional
      isPolyArb ? 1 : 0,                        // 16: is poly arb
      isDualSide ? 1 : 0,                       // 17: is dual side

      // Side
      isBuyYes ? 1 : 0,                         // 18: buying YES side

      // Trend features
      trendAligned ? 1 : 0,                      // 19: aligned with trend
      trendCounter ? 1 : 0,                      // 20: counter to trend
      trendStrength,                              // 21: trend strength [0, 1]
      trendROC,                                   // 22: rate of change (%)

      // Historical performance
      recentWinRate,                              // 23: recent win rate [0, 1]
      recentPnL,                                  // 24: recent P&L ($)
      streak,                                     // 25: current streak (+/-)

      // Position sizing context
      balanceAvailable,                           // 26: available balance
    ];

    this.featureNames = [
      'spot_move', 'abs_move', 'move_dir', 'time_remaining', 'time_elapsed',
      'volatility', 'high_vol', 'edge', 'model_prob', 'price', 'contracts',
      'yes_spread', 'no_spread', 'combined_ask', 'dual_margin',
      'is_directional', 'is_poly_arb', 'is_dual_side', 'is_buy_yes',
      'trend_aligned', 'trend_counter', 'trend_strength', 'trend_roc',
      'recent_wr', 'recent_pnl', 'streak', 'balance',
    ];

    return features;
  }

  // ===== Lightweight Gradient Boosted Stumps =====

  /**
   * Train a simple gradient-boosted model from historical signal outcomes.
   * Uses decision stumps (single-feature splits) — no external ML library needed.
   *
   * This is intentionally simple: 50-100 stumps, each splitting on one feature.
   * Good enough for signal quality scoring without heavy dependencies.
   */
  async train() {
    const data = await supabase.getTrainingData(10000);
    // Canonical MARKET_SNAPSHOT_YES rows predict the market outcome itself: YES=1, NO=0.
    // Refuse corrupt mappings before they can contaminate training.
    for (const row of data) {
      if ((row.settled_result === 'yes' && Number(row.label) !== 1) ||
          (row.settled_result === 'no' && Number(row.label) !== 0)) {
        console.error(`[ML] ERROR label integrity violation: ${row.ticker} settled=${row.settled_result} label=${row.label}`);
        return false;
      }
    }
    const marketOutcomes = new Map();
    for (const row of data) if (row.ticker && (Number(row.label) === 0 || Number(row.label) === 1)) marketOutcomes.set(row.ticker, Number(row.label));
    const yesMarkets = [...marketOutcomes.values()].filter(v => v === 1).length;
    const noMarkets = [...marketOutcomes.values()].filter(v => v === 0).length;
    const yesSnapshots = data.filter(r => Number(r.label) === 1).length;
    const noSnapshots = data.filter(r => Number(r.label) === 0).length;
    console.log(`[ML] Dataset: ${marketOutcomes.size} settled markets | YES=${yesMarkets} (${yesSnapshots} snapshots) | NO=${noMarkets} (${noSnapshots} snapshots)`);
    if (yesSnapshots === 0 || noSnapshots === 0) {
      console.log('ML training deferred: dataset contains only one settlement class');
      return false;
    }
    if (data.length < 50) {
      console.log(`[ML] Not enough training data (${data.length} samples, need 50+)`);
      return false;
    }

    // Split by WHOLE MARKET, never by individual snapshot. This prevents snapshots
    // from one 15-minute contract leaking into both training and validation.
    const tickers = [...new Set(data.map(d => d.ticker).filter(Boolean))].sort();
    if (tickers.length < 2) {
      console.log(`[ML] Not enough independent markets (${tickers.length}, need 2+)`);
      return false;
    }
    const validationTickers = new Set(tickers.filter((_, i) => i % 5 === 0));
    // With very small ticker counts, guarantee both sides of the split are non-empty.
    if (validationTickers.size === tickers.length) validationTickers.delete(tickers[tickers.length - 1]);
    const trainData = data.filter(d => !validationTickers.has(d.ticker));
    const validationData = data.filter(d => validationTickers.has(d.ticker));
    if (trainData.length < 25 || validationData.length === 0) {
      console.log(`[ML] Market-aware split too small (train=${trainData.length}, validation=${validationData.length})`);
      return false;
    }

    const X = trainData.map(d => d.features);
    const y = trainData.map(d => d.label); // canonical target: 1 = market settled YES, 0 = NO

    // Normalize features using TRAINING markets only.
    const nFeatures = X[0].length;
    this.featureMeans = new Array(nFeatures).fill(0);
    this.featureStds = new Array(nFeatures).fill(1);

    for (let j = 0; j < nFeatures; j++) {
      const col = X.map(row => row[j]);
      this.featureMeans[j] = col.reduce((a, b) => a + b, 0) / col.length;
      const variance = col.reduce((a, v) => a + (v - this.featureMeans[j]) ** 2, 0) / col.length;
      this.featureStds[j] = Math.sqrt(variance) || 1;
    }

    // Normalize
    const Xn = X.map(row => row.map((v, j) => (v - this.featureMeans[j]) / this.featureStds[j]));

    // Train gradient-boosted stumps
    const nTrees = Math.min(100, Math.floor(trainData.length / 5));
    const learningRate = 0.1;
    const residuals = y.map(yi => yi - 0.5); // Start from 0.5 base prediction

    this.trees = [];

    for (let t = 0; t < nTrees; t++) {
      let bestStump = null;
      let bestLoss = Infinity;

      // Try each feature
      for (let j = 0; j < nFeatures; j++) {
        // Try median as split point
        const sorted = Xn.map((row, i) => ({ val: row[j], res: residuals[i] }))
          .sort((a, b) => a.val - b.val);

        const mid = Math.floor(sorted.length / 2);
        const leftRes = sorted.slice(0, mid).map(s => s.res);
        const rightRes = sorted.slice(mid).map(s => s.res);

        if (leftRes.length === 0 || rightRes.length === 0) continue;

        const leftPred = leftRes.reduce((a, b) => a + b, 0) / leftRes.length;
        const rightPred = rightRes.reduce((a, b) => a + b, 0) / rightRes.length;
        const threshold = sorted[mid].val;

        // MSE loss
        let loss = 0;
        for (let i = 0; i < Xn.length; i++) {
          const pred = Xn[i][j] < threshold ? leftPred : rightPred;
          loss += (residuals[i] - pred) ** 2;
        }

        if (loss < bestLoss) {
          bestLoss = loss;
          bestStump = { feature: j, threshold, leftPred, rightPred };
        }
      }

      if (!bestStump) break;

      // Update residuals
      for (let i = 0; i < Xn.length; i++) {
        const pred = Xn[i][bestStump.feature] < bestStump.threshold
          ? bestStump.leftPred : bestStump.rightPred;
        residuals[i] -= learningRate * pred;
      }

      this.trees.push({ ...bestStump, weight: learningRate });
    }

    this.trained = true;
    this.trainingSize = trainData.length;
    this.validationSize = validationData.length;
    this.modelVersion = `v1.0-${Date.now()}`;

    // Evaluate only on held-out markets.
    const validationPreds = validationData.map(d => this.predict(d.features).confidence);
    const correct = validationPreds.reduce((n, p, i) => n + ((p >= 0.5 ? 1 : 0) === validationData[i].label ? 1 : 0), 0);
    this.validationAccuracy = correct / validationData.length;
    this.validationBrier = validationPreds.reduce((sum, p, i) => sum + (p - validationData[i].label) ** 2, 0) / validationData.length;

    console.log(`[ML] Trained ${this.trees.length} stumps on ${trainData.length} snapshots from ${tickers.length - validationTickers.size} markets`);
    console.log(`[ML] Held-out market validation: ${validationData.length} snapshots from ${validationTickers.size} markets | accuracy=${(this.validationAccuracy * 100).toFixed(1)}% brier=${this.validationBrier.toFixed(4)}`);

    // Log feature importance
    const importance = new Array(nFeatures).fill(0);
    for (const tree of this.trees) {
      importance[tree.feature] += Math.abs(tree.leftPred - tree.rightPred);
    }
    const topFeatures = importance
      .map((imp, i) => ({ name: this.featureNames[i] || `f${i}`, imp }))
      .sort((a, b) => b.imp - a.imp)
      .slice(0, 5);
    console.log('[ML] Top features:', topFeatures.map(f => `${f.name}(${f.imp.toFixed(3)})`).join(', '));

    return true;
  }

  /**
   * Predict signal quality confidence [0, 1].
   * Higher = more likely to be a winning trade.
   */
  predict(features) {
    if (!this.trained || this.trees.length === 0) {
      return { confidence: 0.5, modelVersion: 'untrained' };
    }

    // Normalize features
    const xn = features.map((v, j) => (v - (this.featureMeans[j] || 0)) / (this.featureStds[j] || 1));

    // Sum predictions from all stumps
    let score = 0.5; // base prediction
    for (const tree of this.trees) {
      const pred = xn[tree.feature] < tree.threshold ? tree.leftPred : tree.rightPred;
      score += tree.weight * pred;
    }

    // Sigmoid to [0, 1]
    const confidence = 1 / (1 + Math.exp(-4 * (score - 0.5)));

    return {
      confidence: Math.max(0, Math.min(1, confidence)),
      modelVersion: this.modelVersion,
      rawScore: score,
    };
  }

  // ===== RAG Context Retrieval =====

  /**
   * Build a text summary of a trade for RAG embedding.
   */
  tradeToText(signal, outcome) {
    return [
      `Signal: ${signal.type} on ${signal.ticker}`,
      `Side: ${signal.side} at ${signal.priceCents}c`,
      `Edge: ${signal.edge.toFixed(1)}%, Model P: ${(signal.modelProb * 100).toFixed(0)}%`,
      `Reason: ${signal.reason}`,
      outcome ? `Outcome: ${outcome.won ? 'WON' : 'LOST'}, P&L: $${outcome.pnl.toFixed(2)}` : 'Pending',
    ].join(' | ');
  }

  /**
   * Get RAG context for a new signal by finding similar historical trades.
   * Returns a text summary of the most relevant past trades.
   */
  async getRAGContext(signal) {
    if (!supabase.enabled) return null;

    // Get recent signals of the same type for context
    const recent = await supabase.getRecentSignals(signal.ticker, 48);
    const perfStats = await supabase.getStrategyPerformance(7);

    if (recent.length === 0 && Object.keys(perfStats).length === 0) return null;

    const contextParts = [];

    // Strategy performance summary
    if (perfStats[signal.type]) {
      const s = perfStats[signal.type];
      const wr = s.count > 0 ? ((s.wins / s.count) * 100).toFixed(0) : '?';
      contextParts.push(`7-day ${signal.type} performance: ${s.count} trades, ${wr}% WR, P&L: $${s.pnl.toFixed(2)}`);
    }

    // Recent similar signals
    const similar = recent
      .filter(r => r.type === signal.type && r.outcome_won !== null)
      .slice(0, 5);

    if (similar.length > 0) {
      const wins = similar.filter(s => s.outcome_won).length;
      contextParts.push(`Recent ${signal.type} signals: ${wins}/${similar.length} won`);

      const avgEdge = similar.reduce((s, r) => s + (r.edge || 0), 0) / similar.length;
      contextParts.push(`Avg edge of recent signals: ${avgEdge.toFixed(1)}%`);
    }

    return contextParts.length > 0 ? contextParts.join('\n') : null;
  }

  // ===== Integration with Signal Generator =====

  /**
   * Score a signal and decide whether to boost, reduce, or block it.
   * Returns an adjustment factor [0, 2]:
   *   < 0.5: Block signal (ML says very unlikely to win)
   *   0.5-0.8: Reduce position size
   *   0.8-1.2: No adjustment (ML neutral)
   *   1.2-1.5: Boost position size
   *   > 1.5: Strong boost (ML very confident)
   */
  async scoreSignal(signal, marketContext) {
    const features = this.extractFeatures(signal, marketContext);
    const prediction = this.predict(features);
    const ragContext = await this.getRAGContext(signal);

    // Do not persist training observations here. Scoring can happen repeatedly
    // for signals that never trade. The order executor persists exactly one
    // observation after a confirmed fill, keyed by the Kalshi order id.

    // Log prediction
    if (this.trained) {
      await supabase.logPrediction({
        signalId: null,
        modelVersion: this.modelVersion,
        confidence: prediction.confidence,
        predictedOutcome: prediction.confidence > 0.5 ? 1 : 0,
        featuresHash: features.slice(0, 5).map(f => f.toFixed(2)).join(','),
      });
    }

    // Calculate adjustment factor
    let adjustment = 1.0;
    if (this.trained) {
      // Map confidence to adjustment: 0.3 → 0.5x, 0.5 → 1.0x, 0.7 → 1.5x
      adjustment = 0.5 + (prediction.confidence - 0.3) * (1.5 / 0.4);
      adjustment = Math.max(0.3, Math.min(2.0, adjustment));
    }

    return {
      adjustment,
      confidence: prediction.confidence,
      modelVersion: prediction.modelVersion,
      ragContext,
      shouldBlock: adjustment < 0.5,
      features,
    };
  }

  /**
   * Record the outcome of a trade for the feedback loop.
   * Call this after settlement to update training data.
   */
  async recordOutcome(signalId, won, pnl) {
    await supabase.updateSignalOutcome(signalId, { won, pnl });
  }

  describe() {
    return {
      trained: this.trained,
      modelVersion: this.modelVersion,
      trainingSize: this.trainingSize,
      validationSize: this.validationSize,
      validationAccuracy: this.validationAccuracy,
      validationBrier: this.validationBrier,
      trees: this.trees.length,
      features: this.featureNames.length,
    };
  }
}

// Singleton
const pipeline = new MLPipeline();
module.exports = pipeline;
