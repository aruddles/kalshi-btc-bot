/**
 * MasterAgent — Top-level agent that owns the entire bot lifecycle.
 *
 * Responsibilities:
 *  1. Registers all skills with the SkillRegistry
 *  2. Resolves dependencies and initializes skills in topological order
 *  3. Configures the Orchestrator with routes and workflows
 *  4. Runs the main trading loop (scan → analyze → decide → execute)
 *  5. Handles graceful shutdown
 *
 * The MasterAgent is the single entry point — server.js creates it
 * and calls start()/stop(). Everything else is orchestrated through skills.
 */

const EventEmitter = require('events');
const SkillRegistry = require('./skill-registry');
const Orchestrator = require('./orchestrator');
const MLPaperHoldRuntime = require('../../lib/ml-paper-hold');
const { ModelArena } = require('../../lib/model-arena');
const { FinalSelectivityLab } = require('../../lib/final-selectivity-lab');
const { Baymax5kForwardLab } = require('../../lib/baymax-5k-forward-lab');
const { project: projectChallengerFeatures } = require('../../lib/ml-challengers');
const mlPipeline = require('../../lib/ml-pipeline');

// Market Data Skills
const BinancePriceFeed = require('../skills/market-data/binance-price-feed');
const PolymarketPriceFeed = require('../skills/market-data/polymarket-price-feed');
const RedstonePriceFeed = require('../skills/market-data/redstone-price-feed');
const KalshiMarketData = require('../skills/market-data/kalshi-market-data');
const UsdReferenceFeed = require('../skills/market-data/usd-reference-feed');

// Analysis Skills
const ProbabilityModel = require('../skills/analysis/probability-model');
const TrendAnalysis = require('../skills/analysis/trend-analysis');
const SignalGenerator = require('../skills/analysis/signal-generator');
const MLSignalScorer = require('../skills/analysis/ml-signal-scorer');
const MLDataCollector = require('../skills/analysis/ml-data-collector');
const { snapshotSince } = require('../../lib/dashboard-since');

// Trading Skills
const RiskManager = require('../skills/trading/risk-manager');
const OrderExecutor = require('../skills/trading/order-executor');
const PositionManager = require('../skills/trading/position-manager');

// Infrastructure Skills
const StateManager = require('../skills/infrastructure/state-manager');
const AnalyticsRecorder = require('../skills/infrastructure/analytics-recorder');

class MasterAgent extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.registry = new SkillRegistry();
    this.orchestrator = new Orchestrator(this.registry);

    this.running = false;
    this._scanInterval = null;
    this._takeProfitInterval = null;
    this._discoveryInterval = null;
    this._balanceInterval = null;
    this.mlPaper = new MLPaperHoldRuntime({ enabled: !!config.ML_PAPER_ENABLED, startingCash: config.ML_PAPER_STARTING_CASH ?? 100, specialistStartingCash: config.ML_PAPER_SPECIALIST_STARTING_CASH ?? 100, minEdge: config.ML_PAPER_MIN_EDGE ?? 0.05, maxContracts: config.ML_PAPER_MAX_CONTRACTS ?? 1, maxExposure: config.ML_PAPER_MAX_EXPOSURE ?? 10, feeRate: config.KALSHI_TAKER_FEE_RATE ?? 0.07 });
    this.modelArena = new ModelArena({ enabled: !!config.ML_PAPER_ENABLED, startingCash: config.MODEL_ARENA_STARTING_CASH ?? 100, minEdge: config.ML_PAPER_MIN_EDGE ?? 0.05, contracts: config.MODEL_ARENA_CONTRACTS ?? 1, maxExposure: config.ML_PAPER_MAX_EXPOSURE ?? 10, feeRate: config.KALSHI_TAKER_FEE_RATE ?? 0.07 });
    this.finalSelectivityLab = new FinalSelectivityLab({ enabled: config.FINAL_SELECTIVITY_ENABLED !== false, startingCash: config.FINAL_SELECTIVITY_STARTING_CASH ?? 100, maxExposure: config.ML_PAPER_MAX_EXPOSURE ?? 10, feeRate: config.KALSHI_TAKER_FEE_RATE ?? 0.07 });
    this.baymax5kForward = new Baymax5kForwardLab({ enabled: config.BAYMAX5K_FORWARD_ENABLED !== false, startingCash: config.BAYMAX5K_FORWARD_STARTING_CASH ?? 100, feeRate: config.KALSHI_TAKER_FEE_RATE ?? 0.07 });

    this._registerSkills();
    this._configureRoutes();
    this._configureWorkflows();
  }

  /**
   * Access the state manager skill (used by server.js for snapshot/save).
   */
  get state() {
    const sm = this.registry.get('state-manager');
    return sm ? sm.botState : null;
  }

  // ===== Skill Registration =====

  _registerSkills() {
    // Infrastructure (no dependencies — initialized first)
    this.registry.register(new StateManager());
    this.registry.register(new AnalyticsRecorder());

    // Market Data (depends on state-manager)
    this.registry.register(new BinancePriceFeed());
    this.registry.register(new PolymarketPriceFeed());
    this.registry.register(new RedstonePriceFeed());
    this.registry.register(new KalshiMarketData());
    this.registry.register(new UsdReferenceFeed());

    // Analysis (depends on market data skills)
    this.registry.register(new TrendAnalysis());
    this.registry.register(new ProbabilityModel());
    this.registry.register(new SignalGenerator());
    this.registry.register(new MLSignalScorer());
    this.registry.register(new MLDataCollector());

    // Trading (depends on analysis + market data)
    this.registry.register(new RiskManager());
    this.registry.register(new OrderExecutor());
    this.registry.register(new PositionManager());
  }

  // ===== Route Configuration =====

  _configureRoutes() {
    const o = this.orchestrator;

    // Direct routes — action → skill
    o.route('fetch-balance', 'kalshi-market-data');
    o.route('discover-markets', 'kalshi-market-data');
    o.route('refresh-markets', 'kalshi-market-data');
    o.route('fetch-market', 'kalshi-market-data');
    o.route('reconcile-positions', 'kalshi-market-data');

    o.route('get-binance-price', 'binance-price-feed');
    o.route('get-volatility', 'binance-price-feed');

    o.route('get-polymarket-price', 'polymarket-price-feed');

    o.route('get-redstone-price', 'redstone-price-feed');

    o.route('get-reference-price', 'usd-reference-feed');
    o.route('get-reference-status', 'usd-reference-feed');

    o.route('calculate-probability', 'probability-model');
    o.route('get-trend', 'trend-analysis');

    o.route('generate-signals', 'signal-generator');
    o.route('generate-take-profit-signals', 'signal-generator');

    o.route('score-signal', 'ml-signal-scorer');
    o.route('score-signals', 'ml-signal-scorer');
    o.route('train-model', 'ml-signal-scorer');
    o.route('get-ml-status', 'ml-signal-scorer');

    o.route('check-risk', 'risk-manager');
    o.route('check-position-limits', 'risk-manager');
    o.route('check-balance', 'risk-manager');
    o.route('risk-status', 'risk-manager');

    o.route('place-order', 'order-executor');
    o.route('cancel-order', 'order-executor');
    o.route('check-order-status', 'order-executor');

    o.route('take-profit', 'position-manager');
    o.route('settle-position', 'position-manager');

    o.route('save-state', 'state-manager');
    o.route('get-snapshot', 'state-manager');

    o.route('log-signal', 'analytics-recorder');
    o.route('log-order', 'analytics-recorder');
    o.route('log-market-snapshot', 'analytics-recorder');

    // Parallel routes — fetch all price feeds at once
    o.parallel('refresh-all-prices', [
      'binance-price-feed',
      'polymarket-price-feed',
      'redstone-price-feed',
    ]);
  }

  // ===== Workflow Configuration =====

  _configureWorkflows() {
    const o = this.orchestrator;

    // Main scan-and-trade workflow — each step's result merges into ctx for the next
    o.workflow('scan-and-trade', {
      steps: [
        {
          action: 'refresh-markets',
          skill: 'kalshi-market-data',
        },
        {
          action: 'generate-signals',
          skill: 'signal-generator',
        },
        {
          action: 'score-signals',
          skill: 'ml-signal-scorer',
          condition: (ctx) => ctx.signals && ctx.signals.length > 0,
        },
        {
          action: 'evaluate-signals',
          skill: 'risk-manager',
          condition: (ctx) => {
            // Use ML-scored signals if available, otherwise fall back to raw signals
            const sigs = ctx.scoredSignals || ctx.signals;
            return sigs && sigs.length > 0;
          },
        },
        {
          action: 'execute-signals',
          skill: 'order-executor',
          condition: (ctx) => ctx.approvedSignals && ctx.approvedSignals.length > 0,
        },
      ],
    });

    // Take-profit workflow
    o.workflow('check-take-profit', {
      steps: [
        {
          action: 'generate-take-profit-signals',
          skill: 'signal-generator',
        },
        {
          action: 'execute-take-profit',
          skill: 'position-manager',
          condition: (ctx) => ctx.takeProfitSignals && ctx.takeProfitSignals.length > 0,
        },
      ],
    });

    // Startup workflow
    o.workflow('startup', {
      steps: [
        { action: 'fetch-balance', skill: 'kalshi-market-data' },
        { action: 'reconcile-positions', skill: 'kalshi-market-data' },
        { action: 'discover-markets', skill: 'kalshi-market-data' },
      ],
    });
  }

  // ===== Lifecycle =====

  async start() {
    this.running = true;
    this.log('MasterAgent starting — initializing skills');

    const stateManager = this.registry.get('state-manager');
    stateManager.botState.updateIntent({
      status: 'initializing',
      message: 'Initializing agent skills...',
    });

    // Build shared context for all skills
    const context = {
      config: this.config,
      registry: this.registry,
      orchestrator: this.orchestrator,
    };

    // Initialize skills in dependency order
    const initOrder = this.registry.getInitOrder();
    this.log(`Init order: ${initOrder.join(' → ')}`);

    for (const skillName of initOrder) {
      const skill = this.registry.get(skillName);
      try {
        await skill.initialize(context);
        this.log(`  initialized ${skillName}`);
      } catch (err) {
        this.log(`  ${skillName} failed: ${err.message}`, 'ERROR');
        throw err;
      }
    }

    // Start all skills
    for (const skillName of initOrder) {
      const skill = this.registry.get(skillName);
      try {
        await skill.start();
      } catch (err) {
        this.log(`  ${skillName} start failed: ${err.message}`, 'ERROR');
      }
    }

    this.log('All skills started');

    // Run startup workflow: fetch balance → reconcile positions → discover markets
    stateManager.botState.updateIntent({
      status: 'initializing',
      message: 'Connecting to Kalshi...',
    });

    const startupResult = await this.orchestrator.dispatch({
      action: 'startup',
      workflow: 'startup',
      params: {},
    });

    if (!startupResult.success) {
      this.log(`Startup workflow failed: ${JSON.stringify(startupResult)}`, 'WARN');
      this.log('Continuing anyway — periodic refresh will retry Kalshi connection', 'WARN');
    } else {
      const balance = stateManager.botState.balance;
      this.log(`Kalshi connected. Balance: $${balance.total.toFixed(2)}`);
      this.log(`Tracking ${stateManager.botState.activeMarkets.length} markets (${this.config.SERIES_TICKER})`);
    }

    // Positions restored from disk: rebuild paper cash/ledger (paper mode) and re-arm the
    // settlement timers, which do not survive a restart.
    const client = this.registry.get('kalshi-market-data').getClient();
    const botState = stateManager.botState;
    if (client.paper) {
      client.paper.restore({ positions: botState.openPositions, realizedPnl: botState.stats.totalPnL || 0 });
      await client.fetchBalance().catch(() => {});
    }
    const positionManager = this.registry.get('position-manager');
    for (const pos of botState.openPositions) {
      const wait = Math.max(5000, (pos.closeTime || 0) - Date.now() + 60000);
      setTimeout(() => positionManager.settlePositionById(pos.orderId), wait);
    }
    this.log(`Trading mode: ${client.tradingMode.toUpperCase()}${client.isPaper ? ' (simulated fills, no real orders)' : ' (REAL ORDERS)'}`, client.isPaper ? 'INFO' : 'WARN');

    // Wait for Binance price feed
    stateManager.botState.updateIntent({
      status: 'waiting',
      message: 'Waiting for Binance price feed...',
    });

    await this._waitForPrice();

    // Start the OrderManager (manages fill polling and stale order cancellation)
    const orderExecutor = this.registry.get('order-executor');
    this.log('Order manager started');

    // Start periodic auto-trade loops
    this._scanInterval = setInterval(() => this._runScan(), 2000);
    this._takeProfitInterval = setInterval(() => this._runTakeProfit(), 3000);
    this._discoveryInterval = setInterval(() => this._runDiscovery(), 15000);
    this._balanceInterval = setInterval(() => this._runBalanceRefresh(), 15000);

    stateManager.botState.updateIntent({
      status: 'scanning',
      message: 'Scanning for opportunities...',
    });

    this.log('Engine running. All systems active.');
    return stateManager.botState;
  }

  async _waitForPrice() {
    const stateManager = this.registry.get('state-manager');
    return new Promise((resolve) => {
      if (stateManager.botState.btcPrice.binance) return resolve();
      const check = setInterval(() => {
        if (stateManager.botState.btcPrice.binance) {
          clearInterval(check);
          this.log(`BTC price: $${stateManager.botState.btcPrice.binance.toFixed(2)}`);
          resolve();
        }
      }, 500);
      setTimeout(() => { clearInterval(check); resolve(); }, 15000);
    });
  }

  // ===== Periodic Auto-Trade Runners =====

  _scanRunning = false;

  /**
   * Main auto-trade loop. Runs every 2 seconds:
   *   refresh markets → generate signals → risk check → execute orders
   */
  async _runScan() {
    if (this._scanRunning || !this.running) return;
    this._scanRunning = true;

    const state = this.state;

    try {
      const result = await this.orchestrator.dispatch({
        action: 'scan-and-trade',
        workflow: 'scan-and-trade',
        params: {},
      });

      if (!result.success) {
        if (result.failedStep) {
          this.log(`Scan workflow failed at step '${result.failedStep}': ${result.stepResults?.find(s => !s.success)?.error || 'unknown'}`, 'ERROR');
        }
        return;
      }

      // Extract results from workflow context to update UI intent
      const ctx = result.context || {};
      await this._runMlPaperHold().catch(err => this.log(`ML PAPER error: ${err.message}`, 'WARN'));

      const signals = ctx.signals || [];
      const approvedSignals = ctx.approvedSignals || [];
      const executedSignals = ctx.executedSignals || [];
      const totalExecuted = ctx.totalExecuted || 0;

      if (signals.length > 0) {
        const best = signals[0];
        state.updateIntent({
          status: totalExecuted > 0 ? 'executing' : 'signal_detected',
          message: totalExecuted > 0
            ? `Executed ${totalExecuted} trade(s)`
            : `${best.type}: ${best.reason}`,
          lastSignal: best,
          modelProbability: best.modelProb,
          currentEdge: best.edge,
          action: `BUY ${best.side.toUpperCase()} @ ${best.priceCents}c`,
        });

        // Log every execution outcome, not just successful fills.
        for (const exec of executedSignals) {
          if (exec.status === 'executed') {
            this.log(`Executed: ${exec.signal} → order ${exec.orderId}`, 'SUCCESS');
          } else if (exec.status === 'no_fill') {
            this.log(`No fill: ${exec.signal} → IOC order ${exec.orderId}`, 'WARN');
          } else if (exec.status === 'blocked' && !exec.quiet) {
            this.log(`Blocked: ${exec.signal} (${exec.reason})`, 'WARN');
          } else if (exec.status === 'error') {
            this.log(`Execution error: ${exec.signal} — ${exec.error}`, 'ERROR');
          }
        }
      } else {
        state.updateIntent({
          status: 'scanning',
          message: 'Scanning for opportunities...',
          currentEdge: null,
          action: null,
        });
      }
    } catch (err) {
      this.log(`Scan error: ${err.message}`, 'ERROR');
    } finally {
      this._scanRunning = false;
    }
  }


  async _runMlPaperHold() {
    const arena=this.modelArena,lab=this.finalSelectivityLab,b5=this.baymax5kForward;if(!arena)return;const state=this.state;const client=this.registry.get('kalshi-market-data')?.getClient?.();
    const arenaPos=Object.values(arena.portfolios).flatMap(p=>p.positions);const labPos=lab?Object.values(lab.policies).flatMap(p=>p.positions):[];const b5Pos=b5?Object.values(b5.policies).flatMap(p=>p.positions):[];const tickers=[...new Set([...arenaPos,...labPos,...b5Pos].map(x=>x.ticker))];
    for(const ticker of tickers){const pos=[...arenaPos,...labPos,...b5Pos].find(x=>x.ticker===ticker);if(pos?.closeTime&&Date.now()<pos.closeTime)continue;try{const market=await client.fetchMarket(ticker);if(market?.result==='yes'||market?.result==='no'){arena.settle(ticker,market.result);lab?.settle(ticker,market.result);b5?.settle(ticker,market.result,Date.now(),{recoveredAfterRestart:b5Pos.some(x=>x.ticker===ticker)});const pos={ticker};mlPipeline.challengers?.settle?.(pos.ticker, market.result);}}catch(_){}}
    if(!arena.enabled||!mlPipeline.trained)return;const scorer=this.registry.get('ml-signal-scorer');
    for(const market of state.activeMarkets||[]){if(!market?.ticker||!market.closeTime||market.closeTime<=Date.now())continue;const modelProb=Number.isFinite(state.model?.impliedProbUp)?state.model.impliedProbUp:.5;const signal={type:'DIRECTIONAL_YES_SNAPSHOT',ticker:market.ticker,side:'yes',edge:(modelProb-(market.yesAsk||.5))*100,modelProb,priceCents:Math.round((market.yesAsk||.5)*100),contracts:0};const ctx=scorer._buildMarketContext(signal,state);const scored=await mlPipeline.scoreSignal(signal,ctx);const sh=mlPipeline.liveShadow||{},reg=sh.regime;if(!['EARLY','LATE','FINAL'].includes(reg))continue;const cp=Number.isFinite(sh.specialistProbability)?sh.specialistProbability:sh.calibratedProbability;const ch=sh.challenger||mlPipeline.challengers?.liveShadow||{};const hp=Number.isFinite(ch.challengerCalibratedProbability)?ch.challengerCalibratedProbability:null;arena.evaluate(`${reg}_CHAMPION`,market,cp);if(Number.isFinite(hp)){arena.evaluate(`${reg}_CHALLENGER`,market,hp);if(reg==='FINAL')lab?.evaluateSharedSnapshot({ticker:market.ticker,timestamp:Date.now(),closeTime:market.closeTime,modelProbability:hp,kalshiProbability:market.yesAsk,yesAsk:market.yesAsk,noAsk:market.noAsk,yesAskSize:market.yesAskSize,noAskSize:market.noAskSize,feeMultiplier:market.feeMultiplier,timeRemainingMs:Math.max(0,market.closeTime-Date.now())});}if(reg==='FINAL'&&b5?.model?.status!=='READY')b5?.reloadModel?.();if(reg==='FINAL'&&b5?.model?.status==='READY'){const f14=projectChallengerFeatures(scored?.features);const p5=f14?b5.predict(f14):null;if(Number.isFinite(p5))b5.evaluateSharedSnapshot({ticker:market.ticker,timestamp:Date.now(),closeTime:market.closeTime,modelProbability:p5,kalshiProbability:market.yesAsk,yesAsk:market.yesAsk,noAsk:market.noAsk,yesAskSize:market.yesAskSize,noAskSize:market.noAskSize,feeMultiplier:market.feeMultiplier,timeRemainingMs:Math.max(0,market.closeTime-Date.now())});}arena.recordComparison(reg,market.ticker);}
  }

  getMlPaperSnapshot() { return snapshotSince(this.modelArena, 'portfolios', this.state?.activeMarkets || []); }
  getModelArenaSnapshot() { return snapshotSince(this.modelArena, 'portfolios', this.state?.activeMarkets || []); }
  getFinalSelectivitySnapshot() { return snapshotSince(this.finalSelectivityLab, 'policies', this.state?.activeMarkets || []); }
  getBaymax5kForwardSnapshot() { return snapshotSince(this.baymax5kForward, 'policies', this.state?.activeMarkets || []); }

  /**
   * Take-profit loop. Runs every 3 seconds for open positions.
   * Sells positions that hit >15% gain or >50% of max possible gain.
   */
  async _runTakeProfit() {
    if (!this.running) return;
    const state = this.state;
    if (!state || state.openPositions.length === 0) return;

    try {
      const result = await this.orchestrator.dispatch({
        action: 'check-take-profit',
        workflow: 'check-take-profit',
        params: {},
      });

      if (!result.success) return;

      const ctx = result.context || {};
      const tpSignals = ctx.takeProfitSignals || [];
      const tpResults = ctx.results || [];

      for (let i = 0; i < tpResults.length; i++) {
        const tp = tpSignals[i];
        const res = tpResults[i];
        if (!tp) continue;

        if (res.status === 'sold') {
          state.updateIntent({
            status: 'taking_profit',
            message: `Take profit on ${tp.ticker}`,
            action: `SELL ${tp.side.toUpperCase()} @ ${tp.sellPriceCents}c`,
          });
          this.log(
            `Take profit: ${tp.ticker} ${tp.side} @ ${tp.sellPriceCents}c (+${tp.profitPct.toFixed(1)}%) | P&L: ${res.pnl >= 0 ? '+' : ''}$${res.pnl.toFixed(2)}`,
            res.pnl >= 0 ? 'SUCCESS' : 'WARN'
          );
        } else if (res.status === 'error') {
          this.log(`Take profit error: ${tp.ticker} — ${res.error}`, 'ERROR');
        }
      }
    } catch (err) {
      this.log(`Take profit error: ${err.message}`, 'ERROR');
    }
  }

  /**
   * Market discovery. Runs every 15 seconds.
   * Finds new active contracts in the KXBTC15M series.
   */
  async _runDiscovery() {
    if (!this.running) return;
    try {
      const result = await this.orchestrator.dispatch({ action: 'discover-markets', params: {} });
      if (result.success && result.count > 0) {
        this.log(`Tracking ${result.count} markets (${this.config.SERIES_TICKER})`);
      }
    } catch (err) {
      this.log(`Discovery error: ${err.message}`, 'ERROR');
    }
  }

  /**
   * Balance refresh. Runs every 15 seconds.
   */
  async _runBalanceRefresh() {
    if (!this.running) return;
    try {
      await this.orchestrator.dispatch({ action: 'fetch-balance', params: {} });
    } catch (err) {
      this.log(`Balance refresh error: ${err.message}`, 'WARN');
    }
  }

  // ===== Shutdown =====

  stop() {
    this.running = false;

    if (this._scanInterval) clearInterval(this._scanInterval);
    if (this._takeProfitInterval) clearInterval(this._takeProfitInterval);
    if (this._discoveryInterval) clearInterval(this._discoveryInterval);
    if (this._balanceInterval) clearInterval(this._balanceInterval);

    // Stop all skills in reverse init order
    const initOrder = this.registry.getInitOrder();
    for (const skillName of [...initOrder].reverse()) {
      try {
        this.registry.get(skillName).stop();
      } catch (err) {
        // ignore cleanup errors
      }
    }

    const stateManager = this.registry.get('state-manager');
    if (stateManager) {
      stateManager.botState.updateIntent({ status: 'stopped', message: 'Bot stopped' });
      const stats = stateManager.botState.stats;
      this.log(`Shutdown. Trades: ${stats.totalTrades} | P&L: $${stats.totalPnL.toFixed(2)}`);
    }
  }

  // ===== Logging =====

  log(msg, level = 'INFO') {
    const ts = new Date().toISOString();
    const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', ERROR: '\x1b[31m', WARN: '\x1b[33m' };
    console.log(`${colors[level] || ''}[${ts}] [MasterAgent] [${level}]\x1b[0m ${msg}`);

    const stateManager = this.registry.get('state-manager');
    if (stateManager && stateManager.botState) {
      stateManager.botState.logTrade({
        type: 'LOG',
        level,
        message: `[MasterAgent] ${msg}`,
      });
    }
  }
}

module.exports = MasterAgent;
