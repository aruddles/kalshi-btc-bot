'use strict';

const { estimateTakerFeeDollars } = require('./kalshi-economics');
const { toCents } = require('./kalshi-format');

/**
 * PaperBroker — simulated order matching against the LIVE displayed book.
 *
 * It sits behind KalshiClient.placeOrder() when TRADING_MODE=paper (the
 * default), so the exact same signal -> risk -> executor -> order-manager ->
 * settlement code runs; only the final POST is replaced by this matcher.
 *
 * Fill model (deliberately conservative):
 *   - Only the best level is available, sized by the market's *_size_fp field.
 *     Unknown size = no fill (we never assume liquidity we cannot see).
 *   - Orders behave as immediate-or-cancel: whatever the best level can fill at
 *     or inside the limit fills; the remainder is cancelled.
 *   - Fees use the same quadratic taker formula as the live sizing code.
 *   - `latencyPenalty` ($/contract, default 1 cent) is charged on every fill to
 *     stand in for adverse movement between decision and fill. It is booked as
 *     extra fees so paper P&L is not flattering. It is NOT a calibrated model.
 *   - Sells can only close contracts held in the paper ledger (reduce-only).
 *   - Queue position, partial depth beyond the touch and cancellations are NOT
 *     modelled — paper results are an upper bound on what live would do.
 */
class PaperBroker {
  constructor({ startingBalance = 100, feeRate = 0.07, feeMultiplier = 1, latencyPenalty = 0.01, now = Date.now } = {}) {
    this.cash = startingBalance;
    this.startingBalance = startingBalance;
    this.feeRate = feeRate;
    this.feeMultiplier = feeMultiplier;
    this.latencyPenalty = latencyPenalty;
    this.now = now;
    this.orders = new Map();
    this.holdings = new Map(); // `${ticker}:${side}` -> contracts
    this.seq = 0;
  }

  _key(ticker, side) { return `${ticker}:${side}`; }

  held(ticker, side) { return this.holdings.get(this._key(ticker, side)) || 0; }

  _touch(spec, market) {
    if (!market) return { price: 0, size: 0 };
    if (spec.action === 'buy') {
      return spec.outcomeSide === 'yes'
        ? { price: market.yesAsk, size: market.yesAskSize }
        : { price: market.noAsk, size: market.noAskSize };
    }
    return spec.outcomeSide === 'yes'
      ? { price: market.yesBid, size: market.yesBidSize }
      : { price: market.noBid, size: market.noBidSize };
  }

  /** Match a normalized order spec against the latest parsed market. */
  place(spec, market) {
    const id = `paper-${++this.seq}-${this.now().toString(36)}`;
    const { price, size } = this._touch(spec, market);
    const crosses = price > 0 && (spec.action === 'buy' ? spec.limitPrice >= price : spec.limitPrice <= price);

    let fill = 0;
    if (crosses && Number.isFinite(size) && size > 0) fill = Math.min(spec.count, Math.floor(size));
    if (spec.action === 'sell') fill = Math.min(fill, this.held(spec.ticker, spec.outcomeSide));

    let fees = 0;
    if (fill > 0) {
      const notional = price * fill;
      fees = estimateTakerFeeDollars(price, fill, this.feeRate, this.feeMultiplier) + this.latencyPenalty * fill;
      if (spec.action === 'buy') {
        if (notional + fees > this.cash + 1e-9) {
          const err = new Error('paper broker: insufficient balance');
          err.response = { status: 400, data: { error: 'insufficient_balance' } };
          throw err;
        }
        this.cash -= notional + fees;
        this.holdings.set(this._key(spec.ticker, spec.outcomeSide), this.held(spec.ticker, spec.outcomeSide) + fill);
      } else {
        this.cash += notional - fees;
        const left = this.held(spec.ticker, spec.outcomeSide) - fill;
        if (left > 1e-9) this.holdings.set(this._key(spec.ticker, spec.outcomeSide), left);
        else this.holdings.delete(this._key(spec.ticker, spec.outcomeSide));
      }
    }

    const order = {
      order_id: id,
      client_order_id: spec.clientOrderId,
      ticker: spec.ticker,
      status: fill > 0 ? 'executed' : 'canceled',
      fill_count: fill,
      remaining_count: spec.count - fill,
      initial_count: spec.count,
      average_fill_price: fill > 0 ? price : undefined,
      average_fee_paid: fill > 0 ? fees / fill : undefined,
      taker_fill_cost: fill > 0 ? toCents(price * fill) : 0,
      taker_fees: toCents(fees),
      paper: true,
    };
    this.orders.set(id, order);
    return { ...order };
  }

  get(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      const err = new Error(`paper broker: unknown order ${orderId}`);
      err.response = { status: 404, data: { error: 'not_found' } };
      throw err;
    }
    return { ...order };
  }

  cancel(orderId) {
    this.get(orderId);
    return { cancelled: true, paper: true };
  }

  /** Settle every paper holding on a market against its real result ('yes'|'no'). */
  settle(ticker, result) {
    let payout = 0;
    for (const side of ['yes', 'no']) {
      const held = this.held(ticker, side);
      if (held > 0 && side === result) payout += held;
      this.holdings.delete(this._key(ticker, side));
    }
    this.cash += payout;
    return payout;
  }

  /**
   * Rebuild ledger and cash after a restart from the persisted bot state, so
   * positions that survive a restart still settle against consistent paper cash:
   *   cash = starting balance + realized P&L so far - cost still tied up in open positions
   */
  restore({ positions = [], realizedPnl = 0 } = {}) {
    this.holdings.clear();
    let tiedUp = 0;
    for (const p of positions) {
      const n = p.filledContracts || p.contracts || 0;
      if (!(n > 0)) continue;
      this.holdings.set(this._key(p.ticker, p.side), this.held(p.ticker, p.side) + n);
      tiedUp += p.totalCost || 0;
    }
    this.cash = this.startingBalance + realizedPnl - tiedUp;
    return this.balance();
  }

  balance() {
    return { total: this.cash, available: this.cash, reserved: 0, portfolioValue: 0 };
  }
}

module.exports = { PaperBroker };
