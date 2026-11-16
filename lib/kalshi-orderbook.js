'use strict';

const PRICE_SCALE = 10000;

function fixedPointPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new TypeError(`Invalid Kalshi price: ${value}`);
  return Math.round(n * PRICE_SCALE);
}

function fixedPointQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`Invalid Kalshi quantity: ${value}`);
  return n;
}

function levelsFromWire(levels, priceScale = 1) {
  if (!Array.isArray(levels)) return [];
  return levels.map(([price, quantity]) => ({
    priceTicks: Math.round(Number(price) * priceScale),
    quantity: fixedPointQuantity(quantity),
  })).filter(level => level.quantity > 0)
    .sort((a, b) => b.priceTicks - a.priceTicks);
}

function normalizeSnapshot(message) {
  const payload = message?.msg || message?.orderbook_fp || message?.orderbook || message;
  const yes = payload.yes_dollars_fp || payload.yes_dollars || payload.yes || [];
  const no = payload.no_dollars_fp || payload.no_dollars || payload.no || [];
  const cents = payload.yes_dollars_fp || payload.no_dollars_fp || payload.yes_dollars || payload.no_dollars ? PRICE_SCALE : 100;
  return {
    ticker: payload.market_ticker || payload.ticker || null,
    yes: levelsFromWire(yes, cents),
    no: levelsFromWire(no, cents),
    seq: Number.isInteger(message?.seq) ? message.seq : null,
    sid: Number.isInteger(message?.sid) ? message.sid : null,
  };
}

function applyDelta(book, message) {
  if (!book || !message?.msg) throw new TypeError('A normalized book and orderbook delta are required');
  const delta = message.msg;
  const side = String(delta.side || '').toLowerCase();
  if (side !== 'yes' && side !== 'no') throw new TypeError(`Invalid Kalshi book side: ${delta.side}`);
  const priceTicks = fixedPointPrice(delta.price_dollars);
  const change = Number(delta.delta_fp);
  if (!Number.isFinite(change)) throw new TypeError(`Invalid Kalshi size delta: ${delta.delta_fp}`);
  const levels = book[side];
  const existing = levels.find(level => level.priceTicks === priceTicks);
  const quantity = (existing?.quantity || 0) + change;
  if (quantity < -1e-8) throw new RangeError('Orderbook delta would produce a negative level quantity');
  if (existing) {
    if (quantity <= 1e-8) levels.splice(levels.indexOf(existing), 1);
    else existing.quantity = quantity;
  } else if (quantity > 1e-8) {
    levels.push({ priceTicks, quantity });
    levels.sort((a, b) => b.priceTicks - a.priceTicks);
  }
  book.seq = Number.isInteger(message.seq) ? message.seq : book.seq;
  return book;
}

function executableQuotes(book) {
  if (!book) return null;
  const bestYesBid = book.yes[0] || null;
  const bestNoBid = book.no[0] || null;
  const bid = level => level ? {
    price: level.priceTicks / PRICE_SCALE,
    quantity: level.quantity,
  } : null;
  const bids = levels => levels.map(bid);
  const asks = levels => levels.map(level => ({
    price: (PRICE_SCALE - level.priceTicks) / PRICE_SCALE,
    quantity: level.quantity,
  })).sort((a, b) => a.price - b.price);
  const yesBids = bids(book.yes);
  const noBids = bids(book.no);
  const yesAsks = asks(book.no);
  const noAsks = asks(book.yes);
  return {
    yesBid: yesBids[0] || null,
    yesAsk: yesAsks[0] || null,
    noBid: noBids[0] || null,
    noAsk: noAsks[0] || null,
    depth: { yesBids, yesAsks, noBids, noAsks },
  };
}

function hasSequenceGap(previous, current) {
  return Number.isInteger(previous) && Number.isInteger(current) && current !== previous + 1;
}

// Replace a market summary's top-of-book with the executable quotes from the live
// order book. Kalshi's market summary can lag the matching engine by several seconds
// in fast moves, so anything that fills, reprices or simulates a fill must use this view.
// A side with no resting level gets price 0 / size 0 (nothing to trade against).
// The summary's own quotes are kept under `summaryQuotes` for auditing.
function overlayExecutable(market, quotes) {
  if (!market || !quotes) return null;
  const px = l => (l && Number.isFinite(l.price) ? l.price : 0), sz = l => (l && Number.isFinite(l.quantity) ? l.quantity : 0);
  return {
    ...market,
    yesBid: px(quotes.yesBid), yesBidSize: sz(quotes.yesBid),
    yesAsk: px(quotes.yesAsk), yesAskSize: sz(quotes.yesAsk),
    noBid: px(quotes.noBid), noBidSize: sz(quotes.noBid),
    noAsk: px(quotes.noAsk), noAskSize: sz(quotes.noAsk),
    quoteSource: 'orderbook',
    summaryQuotes: { yesBid: market.yesBid, yesAsk: market.yesAsk, noBid: market.noBid, noAsk: market.noAsk },
  };
}

module.exports = { PRICE_SCALE, normalizeSnapshot, applyDelta, executableQuotes, hasSequenceGap, overlayExecutable };
