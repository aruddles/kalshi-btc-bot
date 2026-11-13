'use strict';
// Trend-filter test (PRE-REGISTERED 2026-11-13 06:15Z; spec in RESEARCH_LEDGER.md). Read-only research.
//   Counter-trend = side 'yes' with logged "1H: BEARISH", or side 'no' with "1H: BULLISH"
//   (parsed from the trade's `reason`). Data: data/trades.jsonl, entryTime >= REGISTERED_AT only.
//   Metric: counter-trend mean pnl/cost, market-clustered bootstrap 95% CI (2,000, fixed seed).
//   Verdict only with >= 150 counter-trend trades across >= 40 markets:
//     CI < 0 -> FILTER_HELPS; CI > 0 -> COUNTER_TREND_PROFITABLE; else NO_EVIDENCE.
//   Before the threshold, only counts are reported (no P&L), so the result stays unseen.
const { bootstrap } = require('./final-precision-oos');

const REGISTERED_AT = Date.parse('2026-11-13T06:15:00Z');
const MIN_TRADES = 150, MIN_MARKETS = 40, ITER = 2000, SEED = 20261113;

function trendLabel(reason) {
  const m = /1H:\s*(BULLISH|BEARISH|NEUTRAL)/i.exec(reason || '');
  return m ? m[1].toUpperCase() : null;
}
function isCounterTrend(t) {
  const l = trendLabel(t.reason);
  return (t.side === 'yes' && l === 'BEARISH') || (t.side === 'no' && l === 'BULLISH');
}

function evaluate(trades) {
  const cost = t => t.cost ?? t.totalCost;
  const rows = trades
    .filter(t => Number.isFinite(t.entryTime) && t.entryTime >= REGISTERED_AT && Number.isFinite(t.pnl) && cost(t) > 0 && t.ticker)
    .map(t => ({ ticker: t.ticker, pnl: t.pnl, r: t.pnl / cost(t), label: trendLabel(t.reason), counter: isCounterTrend(t) }));
  const ct = rows.filter(x => x.counter);
  const counts = { tradesSinceRegistration: rows.length, counterTrend: ct.length, counterMarkets: new Set(ct.map(x => x.ticker)).size, unlabeled: rows.filter(x => !x.label).length, needed: { MIN_TRADES, MIN_MARKETS } };
  if (ct.length < MIN_TRADES || counts.counterMarkets < MIN_MARKETS) return { status: 'INSUFFICIENT_DATA', counts };
  const mean = s => s.reduce((a, x) => a + x.r, 0) / s.length;
  const ci = bootstrap(ct, mean, ITER, SEED);
  const status = ci.low > 0 ? 'COUNTER_TREND_PROFITABLE' : ci.high < 0 ? 'FILTER_HELPS' : 'NO_EVIDENCE';
  const total = rows.reduce((a, x) => a + x.pnl, 0), ctPnl = ct.reduce((a, x) => a + x.pnl, 0);
  return { status, counts, counterMeanReturn: mean(ct), ci, pnlAll: total, pnlWithoutCounterTrend: total - ctPnl, counterTrendPnl: ctPnl };
}

module.exports = { REGISTERED_AT, trendLabel, isCounterTrend, evaluate };
