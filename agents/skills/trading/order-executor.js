/**
 * OrderExecutor Skill
 *
 * Handles order placement and lifecycle management.
 * Wraps the existing OrderManager for fill tracking and stale order cancellation.
 *
 * Capabilities: execute-signals, place-order, cancel-order, check-order-status
 */

const BaseSkill = require('../../core/base-skill');
const OrderManager = require('../../../bot/order-manager');
const { formatPrice } = require('../../../lib/kalshi-format');
const { estimateTakerFeeDollars, expectedValuePerContract } = require('../../../lib/kalshi-economics');
const { normalizeSnapshot, executableQuotes } = require('../../../lib/kalshi-orderbook');
const supabase = require('../../../lib/supabase');

class OrderExecutor extends BaseSkill {
  constructor() {
    super({
      name: 'order-executor',
      description: 'Places orders on Kalshi and manages order lifecycle (fills, cancellations)',
      domain: 'trading',
      capabilities: ['execute-signals', 'place-order', 'cancel-order', 'check-order-status'],
      dependencies: ['state-manager', 'kalshi-market-data', 'analytics-recorder', 'risk-manager'],
    });

    this.orderManager = null;
    this.maxPositionSize = 25;
    this.rejectionCooldowns = new Map();
    this.rejectionCooldownMs = 5 * 60 * 1000;
    this.noFillCooldowns = new Map();
    this.noFillCooldownMs = 15 * 1000;
  }

  async initialize(context) {
    await super.initialize(context);

    const stateManager = context.registry.get('state-manager');
    const kalshiSkill = context.registry.get('kalshi-market-data');
    const analyticsSkill = context.registry.get('analytics-recorder');

    this.orderManager = new OrderManager(
      kalshiSkill.getClient(),
      stateManager.botState,
      analyticsSkill.getDB(),
      context.config
    );

    this.maxPositionSize = context.config.MAX_POSITION_SIZE || 25;

    const mode = kalshiSkill.getClient().tradingMode;
    console.log(mode === 'live'
      ? '[OrderExecutor] *** TRADING_MODE=live: real orders WILL be sent to Kalshi ***'
      : mode === 'paper+'
        ? '[OrderExecutor] TRADING_MODE=paper+: AGGRESSIVE paper strategy; simulated fills only, nothing is sent to Kalshi'
        : '[OrderExecutor] TRADING_MODE=paper: baseline strategy; simulated fills only, nothing is sent to Kalshi');
  }

  async start() {
    await super.start();
    this.orderManager.start();
  }

  async handleTask(task) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const analyticsSkill = this.context.registry.get('analytics-recorder');
    const riskSkill = this.context.registry.get('risk-manager');

    switch (task.action) {
      case 'execute-signals': {
        const signals = task.params?.approvedSignals || [];
        const results = [];
        let executedCount = 0;
        let attempts = 0;
        const maxPerScan = 2;
        let lastTicker = null;

        for (const signal of signals) {
          if (attempts >= maxPerScan) break;

          const cooldownKey = `${signal.ticker}:${signal.side}`;
          const cooldown = this.rejectionCooldowns.get(cooldownKey);
          if (cooldown && cooldown.until > Date.now()) {
            const secs = Math.ceil((cooldown.until - Date.now()) / 1000);
            console.log(`[OrderExecutor] COOLDOWN: ${signal.ticker} ${signal.side} — ${cooldown.reason}; retry suppressed for ${secs}s`);
            results.push({ signal: signal.ticker, status: 'blocked', reason: `exchange_rejection_cooldown:${cooldown.reason}` });
            continue;
          }
          if (cooldown) this.rejectionCooldowns.delete(cooldownKey);

          const noFillCooldown = this.noFillCooldowns.get(cooldownKey);
          if (noFillCooldown && noFillCooldown > Date.now()) {
            // Logged once when the cooldown starts; repeating it every scan is noise.
            results.push({ signal: signal.ticker, status: 'blocked', reason: 'no_fill_cooldown', quiet: true });
            continue;
          }
          if (noFillCooldown) this.noFillCooldowns.delete(cooldownKey);

          // Final risk check before execution
          const riskCheck = await riskSkill.execute({
            action: 'check-risk',
            params: { signal },
          });

          if (!riskCheck.success || !riskCheck.approved) {
            results.push({ signal: signal.ticker, status: 'blocked', reason: riskCheck.reason || 'risk_check_failed' });
            continue;
          }

          if (lastTicker === signal.ticker) await sleep(100);

          const result = await this._executeSignal(signal, state, kalshiSkill, analyticsSkill);
          results.push(result);
          // Count every order that reached the exchange (fills and IOC no-fills) so a
          // signal that never fills cannot be re-sent for each remaining candidate.
          if (result.status === 'executed') executedCount++;
          attempts += (result.status === 'executed' || result.status === 'no_fill') ? 1 : 0;
          if (result.status === 'no_fill') {
            this.noFillCooldowns.set(`${signal.ticker}:${signal.side}`, Date.now() + this.noFillCooldownMs);
            console.log(`[OrderExecutor] NO-FILL COOLDOWN: ${signal.ticker} ${signal.side} — suppressing retries for ${Math.round(this.noFillCooldownMs / 1000)}s`);
          }
          if (result.status === 'error') {
            const reason = result.error || 'exchange_error';
            this.rejectionCooldowns.set(`${signal.ticker}:${signal.side}`, { until: Date.now() + this.rejectionCooldownMs, reason });
            console.log(`[OrderExecutor] REJECTION COOLDOWN: ${signal.ticker} ${signal.side} — suppressing retries for ${Math.round(this.rejectionCooldownMs / 1000)}s`);
            break; // don't hammer the API after a failure
          }
          lastTicker = signal.ticker;
        }

        return { executedSignals: results, totalExecuted: executedCount };
      }

      case 'place-order': {
        const orderData = task.params?.orderData;
        const order = await kalshiSkill.getClient().placeOrder(orderData);
        return { order };
      }

      case 'cancel-order': {
        const orderId = task.params?.orderId;
        await kalshiSkill.getClient().cancelOrder(orderId);
        return { cancelled: true };
      }

      case 'check-order-status': {
        const orderId = task.params?.orderId;
        const order = await kalshiSkill.getClient().getOrder(orderId);
        return { order };
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  async _executeSignal(signal, state, kalshiSkill, analyticsSkill) {
    const riskSkill = this.context.registry.get('risk-manager');
    const client = kalshiSkill.getClient();

    // Log signal
    const signalId = analyticsSkill.logSignalDirect(signal, true);

    // Snapshot market state
    const market = state.activeMarkets.find(m => m.ticker === signal.ticker);
    if (market) {
      analyticsSkill.logMarketSnapshotDirect(market, state.btcPrice.binance, 'pre_execution');
    }

    try {
      // LIVE IOC REPRICING: a signal price can be stale by the time it reaches the
      // exchange. Immediately before submission, refresh Kalshi's executable ask,
      // recompute fee-adjusted edge, and only trade if the opportunity still meets
      // the configured edge floor. Never chase beyond the risk/position budget.
      let executionPrice = Number(signal.priceDecimal);
      let executionContracts = Number(signal.contracts);
      let executionEdge = Number(signal.edge);
      {
        let freshAsk;
        if (client.isPaper) {
          // Paper mode reprices exactly like live, from the same fresh market quote the
          // PaperBroker fills against. Before v3.7 paper sent the 2-5s-old signal price,
          // so it recorded IOC no-fills (and cooldowns) that live would not have.
          const fresh = await client.fetchMarket(signal.ticker);
          freshAsk = Number(signal.side === 'yes' ? fresh?.yesAsk : fresh?.noAsk);
        } else {
          // The order book is authoritative for IOC execution. Kalshi's market
          // summary can lag the matching engine enough to produce repeated 0-fill IOCs.
          const bookResp = await client.get(`/trade-api/v2/markets/${signal.ticker}/orderbook?depth=20`);
          const rawBook = bookResp.data?.orderbook_fp || bookResp.data?.orderbook || bookResp.data;
          const quotes = executableQuotes(normalizeSnapshot(rawBook));
          const askLevel = signal.side === 'yes' ? quotes?.yesAsk : quotes?.noAsk;
          freshAsk = Number(askLevel?.price);
        }
        if (!Number.isFinite(freshAsk) || freshAsk <= 0 || freshAsk >= 1) {
          console.log(`[OrderExecutor] REPRICE SKIP: ${signal.ticker} ${signal.side} — fresh order-book ask unavailable`);
          return { signal: signal.ticker, status: 'blocked', reason: 'fresh_orderbook_ask_unavailable' };
        }

        const feeRate = this.context.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
        const feeMultiplier = signal.feeMultiplier ?? market?.feeMultiplier ?? 1;
        const feePerContract = estimateTakerFeeDollars(freshAsk, 1, feeRate, feeMultiplier);
        const netEv = expectedValuePerContract(Number(signal.modelProb), freshAsk, feePerContract);
        executionEdge = netEv * 100;
        // Same floor as live; PAPER+ keeps its deliberately lower experimental floor.
        const minExecutionEdge = client.tradingMode === 'paper+'
          ? Number(this.context.config.PAPER_PLUS_MIN_EDGE ?? 3)
          : Number(this.context.config.MIN_EDGE ?? 10);

        const affordableByPosition = Math.floor(Number(this.maxPositionSize) / (freshAsk + feePerContract));
        const affordableByBalance = Math.floor(Number(state.balance.available || 0) / (freshAsk + feePerContract));
        executionContracts = Math.min(executionContracts, affordableByPosition, affordableByBalance);

        console.log(`[OrderExecutor] REPRICE: ${signal.ticker} ${signal.side.toUpperCase()} signal=${(Number(signal.priceDecimal) * 100).toFixed(1)}c fresh=${(freshAsk * 100).toFixed(1)}c | edge ${Number(signal.edge).toFixed(1)}% -> ${executionEdge.toFixed(1)}% | contracts ${signal.contracts} -> ${executionContracts}`);

        if (!Number.isFinite(executionEdge) || executionEdge < minExecutionEdge) {
          console.log(`[OrderExecutor] REPRICE SKIP: ${signal.ticker} ${signal.side} — fresh edge ${executionEdge.toFixed(1)}% < ${minExecutionEdge.toFixed(1)}% minimum`);
          return { signal: signal.ticker, status: 'blocked', reason: `fresh_edge_below_min:${executionEdge.toFixed(2)}%` };
        }
        if (executionContracts < 1) {
          console.log(`[OrderExecutor] REPRICE SKIP: ${signal.ticker} ${signal.side} — fresh price/fees exceed position or balance budget`);
          return { signal: signal.ticker, status: 'blocked', reason: 'fresh_price_exceeds_budget' };
        }
        executionPrice = freshAsk;
      }

      const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      // IOC at the just-refreshed executable ask: fill immediately or cancel.
      const orderData = {
        ticker: signal.ticker,
        action: 'buy',
        side: signal.side,
        count: executionContracts,
        type: 'limit',
        time_in_force: 'immediate_or_cancel',
        client_order_id: clientOrderId,
      };
      const priceStr = formatPrice(executionPrice);
      if (signal.side === 'yes') orderData.yes_price_dollars = priceStr;
      else orderData.no_price_dollars = priceStr;

      state.updateIntent({
        status: 'executing',
        message: `Executing ${signal.type}...`,
        action: `BUY ${signal.side.toUpperCase()} ${signal.ticker} x${executionContracts} @ ${Math.round(executionPrice * 100)}c`,
      });

      console.log(`[OrderExecutor] [${client.tradingMode.toUpperCase()}] Executing: ${signal.type} ${signal.ticker} ${signal.side} x${executionContracts} @ ${Math.round(executionPrice * 100)}c | Fresh Edge: ${executionEdge.toFixed(1)}%`);

      const order = await client.placeOrder(orderData);
      const filled = order.fill_count || 0;

      console.log(`[OrderExecutor] Order ${order.order_id}: ${order.status} | Filled: ${filled}/${executionContracts}`);

      // Log order
      analyticsSkill.logOrderDirect({
        order_id: order.order_id, client_order_id: clientOrderId,
        ticker: signal.ticker, side: signal.side, action: 'buy',
        price_cents: Math.round(executionPrice * 100), count: executionContracts,
        status: order.status, fill_count: filled,
        taker_fill_cost: order.taker_fill_cost || 0,
        taker_fees: order.taker_fees || 0, close_time: signal.closeTime,
      }, signalId);

      // An IOC that found nothing to fill is a normal outcome, not a failure,
      // and it must not touch balance, positions or settlement scheduling.
      if (filled <= 0) {
        riskSkill.recordExecution({ ok: true, noFill: true });
        return { signal: signal.ticker, status: 'no_fill', orderId: order.order_id };
      }

      riskSkill.recordExecution({ ok: true });

      // Actual economics from the exchange response (cents -> dollars).
      const fillCost = (order.taker_fill_cost || executionPrice * filled * 100) / 100;
      const entryFees = (order.taker_fees || 0) / 100;
      const avgPrice = order.average_fill_price ?? fillCost / filled;
      const totalCost = fillCost + entryFees;

      // Live-mode check that the fee model used for sizing matches the exchange.
      if (!client.isPaper && Number.isFinite(order.average_fee_paid)) {
        const rate = this.context.config.KALSHI_TAKER_FEE_RATE ?? 0.07;
        const mult = signal.feeMultiplier ?? market?.feeMultiplier ?? 1;
        riskSkill.recordFeeObservation({
          estimatedPerContract: estimateTakerFeeDollars(avgPrice, 1, rate, mult),
          actualPerContract: order.average_fee_paid,
        });
      }

      // Add to pending orders; OrderManager promotes the fills to a position and
      // reconciles against the exchange's final numbers on its next poll.
      const pendingOrder = {
        orderId: order.order_id, clientOrderId,
        ticker: signal.ticker, signalType: signal.type,
        side: signal.side, contracts: executionContracts,
        fillCount: filled,
        priceCents: Math.round(avgPrice * 100), priceDecimal: avgPrice,
        entryFees, entryFeeFills: filled,
        feeMultiplier: signal.feeMultiplier ?? market?.feeMultiplier ?? 1,
        reservedCost: 0, // IOC: nothing is left resting, so nothing is reserved
        edge: executionEdge, modelProb: signal.modelProb,
        reason: signal.reason, placedAt: Date.now(),
        closeTime: signal.closeTime, orderStatus: order.status,
        isDualSide: signal.isDualSide || false,
        mlObservationId: `kalshi-order:${order.order_id}`,
        mlFeatures: Array.isArray(signal.mlFeatures) ? signal.mlFeatures : null,
        mlPredictedSide: signal.side,
      };

      this.orderManager.addPendingOrder(pendingOrder);

      // ML training rows are trade observations, not scan observations. Persist once
      // only after a confirmed fill. The deterministic Kalshi order id makes retries
      // idempotent, and the label remains NULL until actual market settlement.
      if (pendingOrder.mlFeatures) {
        await supabase.logFeatures({
          observationId: pendingOrder.mlObservationId,
          ticker: pendingOrder.ticker,
          signalType: pendingOrder.signalType,
          predictedSide: pendingOrder.mlPredictedSide,
          vector: pendingOrder.mlFeatures,
          label: null,
          signalId: null,
        });
      }

      // Deduct what was actually spent so the next scan sees an accurate balance.
      state.balance.available = Math.max(0, state.balance.available - totalCost);

      state.stats.volumeTraded += totalCost;
      state.stats.totalEdge += executionEdge;
      state.stats.avgEdge = state.stats.totalEdge / (state.stats.totalTrades + state.openPositions.length || 1);

      state.logTrade({
        type: 'TRADE', action: 'BUY', side: signal.side,
        ticker: signal.ticker, contracts: filled,
        price: pendingOrder.priceCents, edge: executionEdge,
        signalType: signal.type, reason: signal.reason,
      });

      state.emitStats();

      // Schedule settlement check
      const timeToSettle = signal.closeTime - Date.now() + 60000;
      if (timeToSettle > 0) {
        const positionManager = this.context.registry.get('position-manager');
        // unref: a pending settlement timer must not keep the process alive on its own.
        setTimeout(() => positionManager.settlePositionById(pendingOrder.orderId), timeToSettle).unref?.();
      }

      // Refresh balance
      await client.fetchBalance();

      return { signal: signal.ticker, status: 'executed', orderId: order.order_id, filled };
    } catch (err) {
      const detail = err.response
        ? `${err.response.status} - ${JSON.stringify(err.response.data)}`
        : err.message;
      // A guard block is a deliberate refusal, not an execution failure.
      if (err.name === 'TradingBlockedError') {
        return { signal: signal.ticker, status: 'blocked', reason: err.reason };
      }
      riskSkill.recordExecution({ ok: false, error: err });
      return { signal: signal.ticker, status: 'error', error: detail };
    }
  }

  async stop() {
    if (this.orderManager) this.orderManager.stop();
    await super.stop();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = OrderExecutor;
