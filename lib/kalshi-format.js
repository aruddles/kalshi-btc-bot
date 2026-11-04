'use strict';

/**
 * Kalshi wire-format helpers.
 *
 * Kalshi's current API returns prices as fixed-point dollar strings ("0.5600",
 * up to 6 decimals) and contract counts as fixed-point strings ("10.00").
 * Integer-cent fields no longer exist on the market object.
 *
 * Internal conventions used by the rest of this bot (unchanged from before so
 * the strategy / risk / position code keeps working):
 *   - prices        : JS numbers in dollars (0.56)
 *   - *Cents fields : rounded cents, for display only
 *   - order costs/fees on normalized orders (`taker_fill_cost`, `taker_fees`):
 *     CENTS as numbers (the DB/settlement code divides by 100)
 *
 * Every parser accepts the legacy integer-cent field as a fallback so a stale
 * fixture or an older endpoint does not silently turn into NaN.
 */

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundTo(n, decimals) {
  return Number(n.toFixed(decimals));
}

/** Dollar value from a `*_dollars` string, falling back to a legacy cents integer. */
function dollarsOf(dollarField, legacyCents) {
  const d = toNumber(dollarField);
  if (d !== null) return d;
  const c = toNumber(legacyCents);
  return c === null ? null : roundTo(c / 100, 6);
}

/** Contract count from a `*_fp` string, falling back to a legacy integer. */
function countOf(fpField, legacyInt) {
  const f = toNumber(fpField);
  if (f !== null) return f;
  return toNumber(legacyInt);
}

function toCents(dollars) {
  return dollars === null || dollars === undefined ? null : roundTo(dollars * 100, 4);
}

function displayCents(dollars) {
  return dollars === null || dollars === undefined ? null : Math.round(dollars * 100);
}

/** Format a dollar price for an order request. Throws on anything outside (0, 1). */
function formatPrice(price, decimals = 4) {
  const n = toNumber(price);
  if (n === null || n <= 0 || n >= 1) throw new RangeError(`Invalid Kalshi price: ${price}`);
  return n.toFixed(decimals);
}

/** Format a contract count for an order request ("10.00"). */
function formatCount(count) {
  const n = toNumber(count);
  if (n === null || n <= 0) throw new RangeError(`Invalid Kalshi contract count: ${count}`);
  return n.toFixed(2);
}

function stripUndefined(obj) {
  for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key];
  return obj;
}

/**
 * Normalize a Kalshi market object. A missing/zero ask means "no executable
 * quote" and is returned as 0 so callers' `!market.yesAsk` guards still work.
 *
 * Depth note: Kalshi only shows YES-side sizes on the market object. Buying NO
 * hits resting YES bids, so NO-ask size == YES-bid size (and vice versa).
 */
function parseMarket(m) {
  if (!m || typeof m !== 'object') return null;
  const yesBid = dollarsOf(m.yes_bid_dollars, m.yes_bid);
  const yesAsk = dollarsOf(m.yes_ask_dollars, m.yes_ask);
  const noBid = dollarsOf(m.no_bid_dollars, m.no_bid);
  const noAsk = dollarsOf(m.no_ask_dollars, m.no_ask);
  const lastPrice = dollarsOf(m.last_price_dollars, m.last_price);
  const yesBidSize = countOf(m.yes_bid_size_fp);
  const yesAskSize = countOf(m.yes_ask_size_fp);
  const openTime = Date.parse(m.open_time);
  const closeTime = Date.parse(m.close_time);

  return stripUndefined({
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    title: m.title || m.yes_sub_title,
    status: m.status,
    result: m.result || '',
    openTime: Number.isFinite(openTime) ? openTime : undefined,
    closeTime: Number.isFinite(closeTime) ? closeTime : undefined,
    yesBid: yesBid ?? 0,
    yesAsk: yesAsk ?? 0,
    noBid: noBid ?? 0,
    noAsk: noAsk ?? 0,
    lastPrice: lastPrice ?? 0,
    yesBidCents: displayCents(yesBid) ?? 0,
    yesAskCents: displayCents(yesAsk) ?? 0,
    noBidCents: displayCents(noBid) ?? 0,
    noAskCents: displayCents(noAsk) ?? 0,
    yesBidSize: yesBidSize ?? undefined,
    yesAskSize: yesAskSize ?? undefined,
    noBidSize: yesAskSize ?? undefined,
    noAskSize: yesBidSize ?? undefined,
    priceRanges: Array.isArray(m.price_ranges) ? m.price_ranges : undefined,
    // Only present if Kalshi ever sends one; the bot applies its own default.
    feeMultiplier: toNumber(m.fee_multiplier) ?? undefined,
  });
}

/**
 * Normalize an order from GET /portfolio/orders/{id} (or the legacy shape) into
 * the legacy-named shape the order/position code already consumes:
 * fill_count (contracts), taker_fill_cost / taker_fees (CENTS).
 */
function parseOrder(o) {
  if (!o || typeof o !== 'object') return null;
  const fill = countOf(o.fill_count_fp, o.fill_count) ?? 0;
  const remaining = countOf(o.remaining_count_fp, o.remaining_count);
  const initial = countOf(o.initial_count_fp, o.count);
  const takerCost = dollarsOf(o.taker_fill_cost_dollars, o.taker_fill_cost) ?? 0;
  const makerCost = dollarsOf(o.maker_fill_cost_dollars, o.maker_fill_cost) ?? 0;
  const takerFees = dollarsOf(o.taker_fees_dollars, o.taker_fees) ?? 0;
  const makerFees = dollarsOf(o.maker_fees_dollars, o.maker_fees) ?? 0;
  return stripUndefined({
    order_id: o.order_id,
    client_order_id: o.client_order_id,
    ticker: o.ticker,
    status: o.status,
    outcome_side: o.outcome_side || o.side,
    fill_count: fill,
    remaining_count: remaining ?? undefined,
    initial_count: initial ?? undefined,
    // Cost/fees are reported in CENTS for the existing accounting code.
    taker_fill_cost: toCents(takerCost + makerCost),
    taker_fees: toCents(takerFees + makerFees),
    yes_price: dollarsOf(o.yes_price_dollars, o.yes_price) ?? undefined,
    no_price: dollarsOf(o.no_price_dollars, o.no_price) ?? undefined,
  });
}

/**
 * Normalize the V2 create-order response (flat object, no `order` wrapper):
 *   { order_id, fill_count, remaining_count, average_fill_price,
 *     average_fee_paid, ts_ms, client_order_id }
 * `average_fill_price` uses the order's submitted price scale. In V2, direction
 * (`bid`/`ask`) does not transform the price, so NO-side fills keep the same price.
 */
function parseCreateOrderResponse(resp, spec) {
  if (!resp || typeof resp !== 'object') throw new Error('Empty create-order response');
  const body = resp.order && typeof resp.order === 'object' ? resp.order : resp;
  const fill = countOf(body.fill_count_fp, body.fill_count) ?? 0;
  const remaining = countOf(body.remaining_count_fp, body.remaining_count) ?? 0;
  const avgPrice = dollarsOf(body.average_fill_price_dollars ?? body.average_fill_price, null);
  const avgFee = dollarsOf(body.average_fee_paid_dollars ?? body.average_fee_paid, null) ?? 0;

  let perContract = null;
  if (fill > 0 && avgPrice !== null) {
    perContract = avgPrice;
  }

  const terminalImmediate = spec.timeInForce === 'immediate_or_cancel' || spec.timeInForce === 'fill_or_kill';
  let status;
  if (terminalImmediate) status = fill > 0 ? 'executed' : 'canceled';
  else if (remaining <= 0 && fill > 0) status = 'executed';
  else status = body.status || 'resting';

  return stripUndefined({
    order_id: body.order_id,
    client_order_id: body.client_order_id || spec.clientOrderId,
    ticker: spec.ticker,
    status,
    fill_count: fill,
    remaining_count: remaining,
    average_fill_price: perContract === null ? undefined : perContract,
    average_fee_paid: fill > 0 ? avgFee : undefined,
    taker_fill_cost: perContract === null ? 0 : toCents(perContract * fill),
    taker_fees: toCents(avgFee * fill),
    ts_ms: body.ts_ms,
  });
}

function parseBalance(data) {
  const total = dollarsOf(data?.balance_dollars, data?.balance) ?? 0;
  const portfolioValue = dollarsOf(data?.portfolio_value_dollars, data?.portfolio_value) ?? 0;
  // Kalshi's `balance` is the available cash balance. There is no `payout`
  // field in the current response, so nothing is "reserved" here.
  return { total, available: total, reserved: 0, portfolioValue };
}

function parsePosition(p) {
  if (!p || typeof p !== 'object') return null;
  const signed = countOf(p.position_fp, p.position) ?? 0;
  const contracts = Math.abs(signed);
  if (!contracts) return null;
  const exposure = dollarsOf(p.market_exposure_dollars, p.market_exposure) ?? 0;
  return {
    ticker: p.ticker,
    side: signed > 0 ? 'yes' : 'no',
    contracts,
    exposure,
    avgPrice: contracts > 0 ? roundTo(exposure / contracts, 6) : 0,
  };
}

/**
 * Convert the bot's internal order description into a V2 request body.
 * V2 is a single YES-leg book. `bid` buys YES and `ask` sells YES.
 * The bot's NO prices are NO-leg prices, so they MUST be complemented when
 * converted to the V2 YES-leg wire price:
 *   buy  YES @ p -> bid p           sell YES @ p -> ask p
 *   buy  NO  @ q -> ask (1-q)       sell NO  @ q -> bid (1-q)
 */
function buildV2OrderBody(spec) {
  const { ticker, outcomeSide, action, count, limitPrice, timeInForce, clientOrderId, reduceOnly } = spec;
  if (outcomeSide !== 'yes' && outcomeSide !== 'no') throw new TypeError(`Invalid side: ${outcomeSide}`);
  if (action !== 'buy' && action !== 'sell') throw new TypeError(`Invalid action: ${action}`);
  const buyingYesLeg = (action === 'buy') === (outcomeSide === 'yes');
  // V2 order prices are on a single shared price scale: direction does NOT
  // complement the price. Kalshi documents bid == YES and ask == NO.
  // Example: legacy BUY NO @ $0.52 => side=ask, price=0.5200.
  const wirePrice = limitPrice;
  const body = {
    ticker,
    side: buyingYesLeg ? 'bid' : 'ask',
    count: formatCount(count),
    price: formatPrice(wirePrice),
    time_in_force: timeInForce,
    self_trade_prevention_type: 'taker_at_cross',
  };
  if (spec.subaccount !== undefined && spec.subaccount !== null) body.subaccount = Number(spec.subaccount);
  if (spec.exchangeIndex !== undefined && spec.exchangeIndex !== null) body.exchange_index = Number(spec.exchangeIndex);
  if (clientOrderId) body.client_order_id = clientOrderId;
  if (reduceOnly) body.reduce_only = true;
  if (spec.expirationTs) body.expiration_time = spec.expirationTs;
  return body;
}

/**
 * Accept the legacy-shaped order the rest of the bot builds
 * ({ ticker, action, side, count, yes_price|no_price (cents), ... }) and return
 * a normalized spec. Dollar fields (`yes_price_dollars` / `no_price_dollars`)
 * win over cents when both are present.
 */
function specFromOrderData(orderData) {
  const outcomeSide = orderData.side;
  const priceDollars = outcomeSide === 'yes'
    ? dollarsOf(orderData.yes_price_dollars, orderData.yes_price)
    : dollarsOf(orderData.no_price_dollars, orderData.no_price);
  const count = countOf(orderData.count_fp, orderData.count);
  if (priceDollars === null) throw new TypeError('Order is missing a price');
  return {
    ticker: orderData.ticker,
    outcomeSide,
    action: orderData.action,
    count,
    limitPrice: priceDollars,
    timeInForce: orderData.time_in_force || 'good_till_canceled',
    clientOrderId: orderData.client_order_id,
    reduceOnly: Boolean(orderData.reduce_only),
    expirationTs: orderData.expiration_ts,
  };
}

module.exports = {
  toNumber, dollarsOf, countOf, toCents, displayCents,
  formatPrice, formatCount,
  parseMarket, parseOrder, parseCreateOrderResponse, parseBalance, parsePosition,
  buildV2OrderBody, specFromOrderData,
};
