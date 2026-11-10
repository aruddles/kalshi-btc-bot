/**
 * RiskManager Skill
 *
 * Evaluates signals against risk constraints before execution and owns the
 * automatic halts that Rules.md / the README describe. Halts are enforced by the
 * shared TradingGuard (lib/trading-guard.js) that the Kalshi client consults on
 * every buy, so they hold even if some other code path tries to place an order.
 *
 * Enforced here:
 *   - position / per-contract / per-ticker dollar caps, balance check
 *   - total exposure cap (default 50% of bankroll)
 *   - session loss rules: >=10% halves size, >=20% pauses 15 min, >=30% hard stop
 *     (measured on REALIZED P&L since this process started)
 *   - 5 consecutive execution failures -> halt
 *   - balance below the floor ($5 default) -> halt
 *   - stale Binance spot price blocks directional entries
 *   - fee-model drift: actual fees well above the estimate -> halt
 *   - kill switch (KILL file / TRADING_ENABLED=false) via the guard
 *
 * Capabilities: check-risk, evaluate-signals, check-position-limits, check-balance, risk-status
 */

const BaseSkill = require('../../core/base-skill');

const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

class RiskManager extends BaseSkill {
  constructor() {
    super({
      name: 'risk-manager',
      description: 'Evaluates trading signals against risk constraints, position limits and automatic halts',
      domain: 'trading',
      capabilities: ['check-risk', 'evaluate-signals', 'check-position-limits', 'check-balance', 'risk-status'],
      dependencies: ['state-manager', 'analytics-recorder', 'kalshi-market-data'],
    });

    this.maxOpenPositions = 10;
    this.maxPerContract = 1;
    this.maxPositionSize = 25;

    this.maxExposurePct = 0.5;
    this.reduceLossPct = 0.10;
    this.pauseLossPct = 0.20;
    this.hardStopLossPct = 0.30;
    this.pauseMinutes = 15;
    this.maxSessionLossUsd = 0; // 0 = disabled
    this.maxConsecutiveFailures = 5;
    this.balanceFloor = 5;
    this.maxSpotAgeMs = 5000;
    this.feeDriftTolerance = 0.25; // actual per-contract fee may exceed estimate by 25% (and >0.5c)

    this.guard = null;
    this.now = Date.now;
    this.sessionStartPnl = null;
    this.sessionStartBalance = null;
    this.consecutiveFailures = 0;
    this.feeDriftEvents = 0;
    this.lastPauseLoss = 0;
  }

  async initialize(context) {
    await super.initialize(context);
    const c = context.config;
    this.maxOpenPositions = c.MAX_TOTAL_OPEN_POSITIONS || 10;
    this.maxPerContract = c.MAX_POSITIONS_PER_CONTRACT || 1;
    this.maxPositionSize = c.MAX_POSITION_SIZE || 25;
    this.maxExposurePct = num(c.MAX_EXPOSURE_PCT, 0.5);
    this.reduceLossPct = num(c.SESSION_REDUCE_PCT, 0.10);
    this.pauseLossPct = num(c.SESSION_PAUSE_PCT, 0.20);
    this.hardStopLossPct = num(c.SESSION_HARD_STOP_PCT, 0.30);
    this.pauseMinutes = num(c.SESSION_PAUSE_MINUTES, 15);
    this.maxSessionLossUsd = num(c.MAX_SESSION_LOSS_USD, 0);
    this.maxConsecutiveFailures = num(c.MAX_CONSECUTIVE_FAILURES, 5);
    this.balanceFloor = num(c.BALANCE_FLOOR, 5);
    this.maxSpotAgeMs = num(c.MAX_SPOT_AGE_MS, 5000);

    const state = context.registry.get('state-manager').botState;
    this.sessionStartPnl = state.stats.totalPnL || 0;
    this.guard = context.registry.get('kalshi-market-data').getClient().guard;
    this.guard.onChange(status => {
      if (status.blocked) {
        state.updateIntent({ status: 'halted', message: `Entries blocked: ${status.blocked}` });
      }
    });
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;

    switch (task.action) {
      case 'evaluate-signals': {
        // Accept ML-scored signals (preferred) or raw signals
        const signals = task.params?.scoredSignals || task.params?.signals || [];
        const approved = [];

        for (const signal of signals) {
          const check = this._checkSignal(signal, state);
          if (check.approved) {
            approved.push(signal);
          } else {
            // Log blocked signal
            const db = this.context.registry.get('analytics-recorder');
            if (db) db.logBlockedSignal(signal, check.reason);
          }
        }

        return { approvedSignals: approved, rejected: signals.length - approved.length };
      }

      case 'check-risk': {
        const signal = task.params?.signal;
        if (!signal) throw new Error('signal required');
        return this._checkSignal(signal, state);
      }

      case 'check-position-limits': {
        return this._getPositionLimits(state);
      }

      case 'check-balance': {
        return {
          available: state.balance.available,
          total: state.balance.total,
          reserved: state.balance.reserved,
        };
      }

      case 'risk-status': {
        return this.getStatus(state);
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  // ===== Loss tracking =====

  /** Realized loss this session as a positive dollar amount (0 when flat/up). */
  sessionLoss(state) {
    const pnl = (state.stats.totalPnL || 0) - (this.sessionStartPnl ?? 0);
    return Math.max(0, -pnl);
  }

  _startingBalance(state) {
    if (this.sessionStartBalance === null && state.balance.total > 0) this.sessionStartBalance = state.balance.total;
    return this.sessionStartBalance ?? state.startingBalance ?? 0;
  }

  /**
   * Apply the session-loss and balance rules. Returns the size multiplier to
   * use (1 or 0.5) and may halt/pause the guard as a side effect.
   */
  _evaluateSessionRules(state) {
    const loss = this.sessionLoss(state);
    const base = this._startingBalance(state);

    if (state.balance.total > 0 && state.balance.total < this.balanceFloor) {
      this.guard.halt(`balance_below_floor_$${this.balanceFloor}`);
    }

    if (this.maxSessionLossUsd > 0 && loss >= this.maxSessionLossUsd) {
      this.guard.halt(`session_loss_$${loss.toFixed(2)}>=limit`);
    }

    if (base > 0) {
      const pct = loss / base;
      if (pct >= this.hardStopLossPct) {
        this.guard.halt(`session_loss_${(pct * 100).toFixed(1)}%_hard_stop`);
      } else if (pct >= this.pauseLossPct && loss > this.lastPauseLoss + 1e-9) {
        // Pause once per new loss level so a lingering loss does not re-pause forever.
        this.lastPauseLoss = loss;
        this.guard.pause(this.pauseMinutes * 60000, `session_loss_${(pct * 100).toFixed(1)}%`);
      }
      if (pct >= this.reduceLossPct) return 0.5;
    }
    return 1;
  }

  // ===== Execution feedback (called by OrderExecutor) =====

  recordExecution({ ok, error, noFill = false }) {
    if (noFill) return; // an IOC that simply did not fill is not a failure
    if (ok) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures++;
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      this.guard.halt(`auth_failure_${status}`, { hard: true });
    } else if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.guard.halt(`${this.consecutiveFailures}_consecutive_execution_failures`);
    }
  }

  /** Compare the exchange's per-contract fee to what the sizing model assumed. */
  recordFeeObservation({ estimatedPerContract, actualPerContract }) {
    if (![estimatedPerContract, actualPerContract].every(Number.isFinite)) return null;
    const excess = actualPerContract - estimatedPerContract;
    const drifted = excess > 0.005 && actualPerContract > estimatedPerContract * (1 + this.feeDriftTolerance);
    if (drifted) {
      this.feeDriftEvents++;
      console.warn(`[RiskManager] Fee drift: exchange charged ${(actualPerContract * 100).toFixed(2)}c/contract vs modelled ${(estimatedPerContract * 100).toFixed(2)}c`);
      if (this.feeDriftEvents >= 2) {
        this.guard.halt('fee_model_mismatch (check KALSHI_FEE_MULTIPLIER)');
      }
    } else {
      this.feeDriftEvents = 0;
    }
    return { drifted, excess };
  }

  // ===== Signal checks =====

  _checkSignal(signal, state) {
    // Hard gates first: kill switch, halts, pauses.
    const sizeMultiplier = this._evaluateSessionRules(state);
    const blocked = this.guard.blockReason();
    if (blocked) return { approved: false, reason: blocked };

    if (!(state.balance.total > 0)) return { approved: false, reason: 'balance_unavailable' };

    // Directional entries depend on a live Binance reference.
    if (String(signal.type).startsWith('DIRECTIONAL')) {
      const last = state.btcPrice?.lastUpdate;
      if (!last || this.now() - last > this.maxSpotAgeMs) return { approved: false, reason: 'stale_spot_price' };
    }

    // Check total position limits (pending + open)
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    if (totalExposure >= this.maxOpenPositions) {
      return { approved: false, reason: 'max_positions' };
    }

    // Check per-contract limits
    const existingOnTicker = [
      ...state.openPositions.filter(p => p.ticker === signal.ticker),
      ...state.pendingOrders.filter(p => p.ticker === signal.ticker),
    ];
    if (existingOnTicker.length >= this.maxPerContract) {
      return { approved: false, reason: 'per_contract_cap' };
    }

    // Size reduction after drawdown (applied once even though the executor re-checks).
    if (sizeMultiplier < 1 && !signal._riskScaled) {
      const scaled = Math.floor(signal.contracts * sizeMultiplier);
      if (scaled < 1) return { approved: false, reason: 'size_reduced_to_zero' };
      signal.estimatedEntryFee = (signal.estimatedEntryFee ?? 0) * (scaled / signal.contracts);
      signal.contracts = scaled;
      signal._riskScaled = true;
    }

    // Check balance (price + estimated entry fee)
    const fee = signal.estimatedEntryFee ?? 0;
    const cost = signal.priceDecimal * signal.contracts;
    if (cost + fee > state.balance.available) {
      return { approved: false, reason: 'insufficient_balance' };
    }

    // Check cumulative ticker exposure
    const existingCost = existingOnTicker.reduce((sum, p) => sum + (p.totalCost || p.reservedCost || 0), 0);
    if (existingCost + cost > this.maxPositionSize * 1.5) {
      return { approved: false, reason: 'ticker_exposure_cap' };
    }

    // Portfolio exposure cap: open + pending cost must stay under maxExposurePct of bankroll.
    const openCost = state.openPositions.reduce((s, p) => s + (p.totalCost || 0), 0);
    const pendingCost = state.pendingOrders.reduce((s, p) => s + (p.reservedCost || 0), 0);
    const bankroll = state.balance.available + openCost + pendingCost;
    if (bankroll > 0 && openCost + pendingCost + cost + fee > this.maxExposurePct * bankroll) {
      return { approved: false, reason: 'portfolio_exposure_cap' };
    }

    return { approved: true, cost, existingExposure: existingCost, sizeMultiplier };
  }

  _getPositionLimits(state) {
    const totalExposure = state.openPositions.length + state.pendingOrders.length;
    return {
      currentOpen: state.openPositions.length,
      currentPending: state.pendingOrders.length,
      totalExposure,
      maxOpenPositions: this.maxOpenPositions,
      maxPerContract: this.maxPerContract,
      slotsAvailable: Math.max(0, this.maxOpenPositions - totalExposure),
    };
  }

  getStatus(state) {
    const s = state || this.context.registry.get('state-manager').botState;
    return {
      guard: this.guard.status(),
      sessionLoss: this.sessionLoss(s),
      consecutiveFailures: this.consecutiveFailures,
      feeDriftEvents: this.feeDriftEvents,
      mode: this.context.registry.get('kalshi-market-data').getClient().tradingMode,
    };
  }
}

module.exports = RiskManager;
