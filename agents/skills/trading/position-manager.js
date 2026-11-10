/**
 * PositionManager Skill
 *
 * Manages open positions: take-profit execution, settlement resolution,
 * and position lifecycle tracking.
 *
 * Capabilities: take-profit, execute-take-profit, settle-position
 */

const BaseSkill = require('../../core/base-skill');
const supabase = require('../../../lib/supabase');

class PositionManager extends BaseSkill {
  constructor() {
    super({
      name: 'position-manager',
      description: 'Manages position lifecycle: take-profit execution and settlement resolution',
      domain: 'trading',
      capabilities: ['take-profit', 'execute-take-profit', 'settle-position'],
      dependencies: ['state-manager', 'kalshi-market-data', 'analytics-recorder'],
    });
  }

  async initialize(context) {
    await super.initialize(context);
  }

  async handleTask(task) {
    switch (task.action) {
      case 'execute-take-profit': {
        const signals = task.params?.takeProfitSignals || [];
        const results = [];
        for (const tp of signals) {
          const result = await this._executeTakeProfit(tp);
          results.push(result);
        }
        return { results };
      }

      case 'settle-position': {
        const orderId = task.params?.orderId;
        if (!orderId) throw new Error('orderId required');
        return await this._settlePosition(orderId);
      }

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }

  /**
   * Public method for scheduled settlement callbacks.
   */
  async settlePositionById(orderId) {
    try {
      await this._settlePosition(orderId);
    } catch (err) {
      console.error(`[PositionManager] Settlement error for ${orderId}: ${err.message}`);
      setTimeout(() => this.settlePositionById(orderId), 30000);
    }
  }

  async _executeTakeProfit(tp) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');

    try {
      const position = state.openPositions.find(p => p.orderId === tp.orderId);
      if (!position) return { ticker: tp.ticker, status: 'skipped', reason: 'position_not_found' };

      const sellOrder = await kalshiSkill.getClient().sellPosition(
        tp.ticker, tp.side, tp.contracts, tp.sellPriceCents, { priceDollars: tp.sellPriceDecimal }
      );

      const sold = sellOrder.fill_count || 0;
      if (sold <= 0) return { ticker: tp.ticker, status: 'pending' };

      // P&L is net of BOTH fees: proceeds - exit fee - the entry cost (incl. entry
      // fee) of the contracts actually sold.
      const held = position.filledContracts || position.contracts;
      const fraction = Math.min(1, sold / held);
      const proceeds = sellOrder.taker_fill_cost > 0 ? sellOrder.taker_fill_cost / 100 : tp.sellPriceDecimal * sold;
      const exitFees = (sellOrder.taker_fees || 0) / 100;
      const entryCostPortion = (position.totalCost || position.priceDecimal * held) * fraction;
      const pnl = proceeds - exitFees - entryCostPortion;

      if (fraction >= 1 - 1e-9) {
        state.closePosition(tp.orderId, {
          won: pnl > 0, pnl,
          payout: proceeds - exitFees,
          cost: position.totalCost || 0, entryFees: position.entryFees || 0, exitFees,
          originalFilledContracts: held, originalTotalCost: position.totalCost || 0,
          exitType: 'TAKE_PROFIT',
        });
      } else {
        // Partial exit: keep the remainder open and book the realized part.
        position.filledContracts = held - sold;
        position.contracts = Math.max(0, (position.contracts || held) - sold);
        position.totalCost = (position.totalCost || 0) - entryCostPortion;
        state.stats.totalPnL += pnl;
        state.emit('position:updated', position);
      }

      state.logTrade({
        type: 'TRADE', action: 'SELL', side: tp.side,
        ticker: tp.ticker, contracts: sold,
        price: tp.sellPriceCents, pnl, reason: tp.reason,
      });

      return { ticker: tp.ticker, status: 'sold', pnl };
    } catch (err) {
      return { ticker: tp.ticker, status: 'error', error: err.message };
    }
  }

  async _settlePosition(orderId) {
    const state = this.context.registry.get('state-manager').botState;
    const kalshiSkill = this.context.registry.get('kalshi-market-data');
    const analyticsSkill = this.context.registry.get('analytics-recorder');

    const position = state.openPositions.find(p => p.orderId === orderId);
    if (!position) {
      // A full take-profit legitimately closes the financial position before the
      // market settles. It must NOT determine the ML label. Keep following the
      // original prediction until Kalshi publishes the actual YES/NO result.
      const closedTp = state.closedPositions.find(p =>
        p.orderId === orderId && p.exitType === 'TAKE_PROFIT' && p.mlObservationId
      );
      if (closedTp) {
        const market = await kalshiSkill.getClient().fetchMarket(closedTp.ticker);
        if (!market || (market.result !== 'yes' && market.result !== 'no')) {
          setTimeout(() => this.settlePositionById(orderId), 30000).unref?.();
          return { settled: false, reason: 'not_settled_yet_after_take_profit' };
        }
        await supabase.labelFeatureObservation(
          closedTp.mlObservationId, market.result, closedTp.mlPredictedSide || closedTp.side
        );
        closedTp.mlSettlementResult = market.result;
        closedTp.mlLabeled = true;

        // PAPER+ counterfactual: after an early TP, record what the SAME entry
        // would have earned if held through settlement. This is diagnostic only;
        // it never changes cash, realized P&L, or the ML label.
        if (String(this.context?.config?.TRADING_MODE || '').toLowerCase() === 'paper+') {
          const originalContracts = Number(closedTp.originalFilledContracts || closedTp.filledContracts || closedTp.contracts || 0);
          const originalCost = Number(closedTp.originalTotalCost || closedTp.cost || closedTp.totalCost || 0);
          const holdWon = closedTp.side === market.result;
          const holdPayout = holdWon ? originalContracts : 0;
          const holdPnl = holdPayout - originalCost;
          closedTp.holdToSettlementResult = market.result;
          closedTp.holdToSettlementPnl = holdPnl;
          closedTp.exitVsHoldDelta = Number(closedTp.pnl || 0) - holdPnl;
          console.log(`[PositionManager] PAPER+ COUNTERFACTUAL: ${closedTp.ticker} ${closedTp.side} | early-exit P&L=${Number(closedTp.pnl || 0).toFixed(2)} | hold-to-settlement P&L=${holdPnl.toFixed(2)} | exit-minus-hold=${closedTp.exitVsHoldDelta.toFixed(2)}`);
        }

        state.emit('position:updated', closedTp);
        return { settled: true, mlOnly: true, result: market.result, holdToSettlementPnl: closedTp.holdToSettlementPnl };
      }

      // Check if still pending
      const pending = state.pendingOrders.find(p => p.orderId === orderId);
      if (pending) {
        state.removePendingOrder(orderId);
      }
      return { settled: false, reason: 'position_not_found' };
    }

    // Durable position economics are authoritative. Paper orders are intentionally ephemeral
    // and may disappear across restarts; settlement must not depend on broker order memory.
    const durableFilled = Number(position.filledContracts || position.contracts || 0);
    const durableCost = Number(position.totalCost || 0);
    const hasDurableSettlementData = durableFilled > 0 && durableCost > 0;
    let order = null;
    if (!hasDurableSettlementData && position.type !== 'RECONCILED') {
      // Legacy fallback for old persisted positions that predate durable cost metadata.
      order = await kalshiSkill.getClient().getOrder(orderId);
    }
    const filled = hasDurableSettlementData
      ? durableFilled
      : (position.type === 'RECONCILED' ? durableFilled : Math.min(order?.fill_count || 0, durableFilled || order?.fill_count || 0));

    if (filled === 0) {
      state.openPositions = state.openPositions.filter(p => p.orderId !== orderId);
      state.emit('position:removed', position);
      return { settled: false, reason: 'never_filled' };
    }

    const market = await kalshiSkill.getClient().fetchMarket(position.ticker);

    if (!market || (market.result !== 'yes' && market.result !== 'no')) {
      // Not settled yet, retry
      setTimeout(() => this.settlePositionById(orderId), 30000);
      return { settled: false, reason: 'not_settled_yet' };
    }

    const won = position.side === market.result;
    // Cost = what we recorded for the contracts still held, which already includes the
    // entry fee (reconciled against the exchange's own numbers when the fill was confirmed).
    const exchangeCost = order ? ((order.taker_fill_cost || 0) + (order.taker_fees || 0)) / 100 : 0;
    const costDollars = durableCost > 0 ? durableCost : exchangeCost;
    const payout = won ? filled * 1.00 : 0;
    const pnl = payout - costDollars;

    // Update DB
    if (order) analyticsSkill.updateOrderDirect(orderId, 'settled', filled, order.taker_fill_cost || 0, order.taker_fees || 0);
    analyticsSkill.logMarketSnapshotDirect(market, state.btcPrice.binance, 'settlement');

    // ML label is based ONLY on the original YES/NO prediction versus Kalshi's
    // actual settlement. P&L and take-profit behavior never define this target.
    if (position.mlObservationId) {
      await supabase.labelFeatureObservation(
        position.mlObservationId, market.result, position.mlPredictedSide || position.side
      );
    }

    // Keep the paper ledger/cash in step with the real market outcome (no-op in live mode).
    kalshiSkill.getClient().recordSettlement(position.ticker, market.result);

    state.closePosition(orderId, {
      won, pnl, payout, cost: costDollars,
      filledContracts: filled, exitType: 'SETTLEMENT', result: market.result,
    });

    state.logTrade({
      type: 'SETTLEMENT', action: won ? 'WIN' : 'LOSS',
      side: position.side, ticker: position.ticker,
      contracts: filled, pnl, cost: costDollars, payout, result: market.result,
    });

    console.log(
      `[PositionManager] ${won ? 'WON' : 'LOST'}: ${position.ticker} ${position.side} x${filled} | Cost: $${costDollars.toFixed(2)} | Payout: $${payout.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
    );

    await kalshiSkill.getClient().fetchBalance();

    return { settled: true, won, pnl, payout };
  }
}

module.exports = PositionManager;
