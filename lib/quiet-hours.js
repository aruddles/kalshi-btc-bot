'use strict';
// Quiet-hours test for the main (rule-based) bot. Read-only research; never affects trading.
//
// PRE-REGISTERED 2026-11-13 ~02:40Z, before any hour-of-day / weekday split of results was viewed.
//   Hypothesis: main-bot profit per dollar risked differs between quiet and busy hours
//     (fewer professional traders at night / weekends -> sloppier prices).
//   Quiet = Saturday or Sunday (any hour), or a weekday with entry hour 20:00-07:59
//     America/New_York. Busy = everything else. Bucket by trade entryTime.
//   Data: every row of data/trades.jsonl with finite pnl, cost > 0 and entryTime.
//   Metric: per-trade return r = pnl / cost. Statistic: mean r (quiet) - mean r (busy).
//   CI: market-clustered bootstrap 95% CI (2,000 resamples, fixed seed).
//   Verdict only when each bucket has >= 150 trades and >= 40 markets AND >= 30 weekend
//     trades exist; otherwise INSUFFICIENT_DATA (interim numbers may be shown, no decisions).
//     CI entirely > 0 -> QUIET_BETTER; < 0 -> BUSY_BETTER; else NO_SIGNIFICANT_DIFFERENCE.
//   No threshold or bucket-boundary changes after viewing results.
const { bootstrap } = require('./final-precision-oos');

const MIN_TRADES = 150, MIN_MARKETS = 40, MIN_WEEKEND = 30;
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' });

function etParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) };
}
function isWeekend(ms) { const d = etParts(ms).weekday; return d === 'Sat' || d === 'Sun'; }
function isQuiet(ms) {
  const { weekday, hour } = etParts(ms);
  return weekday === 'Sat' || weekday === 'Sun' || hour >= 20 || hour < 8;
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function summarize(rows) {
  return {
    trades: rows.length,
    markets: new Set(rows.map(x => x.ticker)).size,
    pnl: rows.reduce((s, x) => s + x.pnl, 0),
    meanReturn: mean(rows.map(x => x.r)),
    winRate: rows.length ? rows.filter(x => x.pnl > 0).length / rows.length : null,
  };
}

function evaluate(trades, { iterations = 2000 } = {}) {
  const rows = trades
    .filter(t => Number.isFinite(t.pnl) && Number.isFinite(t.cost ?? t.totalCost) && (t.cost ?? t.totalCost) > 0 && Number.isFinite(t.entryTime) && t.ticker)
    .map(t => ({ ticker: t.ticker, pnl: t.pnl, r: t.pnl / (t.cost ?? t.totalCost), quiet: isQuiet(t.entryTime), weekend: isWeekend(t.entryTime) }));
  const quiet = summarize(rows.filter(x => x.quiet)), busy = summarize(rows.filter(x => !x.quiet));
  const weekendTrades = rows.filter(x => x.weekend).length;
  const diffOf = s => {
    const q = mean(s.filter(x => x.quiet).map(x => x.r)), b = mean(s.filter(x => !x.quiet).map(x => x.r));
    return q == null || b == null ? NaN : q - b;
  };
  const diff = diffOf(rows);
  const ci = rows.length ? bootstrap(rows, diffOf, iterations, 20261113) : null;
  const enough = quiet.trades >= MIN_TRADES && busy.trades >= MIN_TRADES && quiet.markets >= MIN_MARKETS &&
    busy.markets >= MIN_MARKETS && weekendTrades >= MIN_WEEKEND;
  let status = 'INSUFFICIENT_DATA';
  if (enough && ci) status = ci.low > 0 ? 'QUIET_BETTER' : ci.high < 0 ? 'BUSY_BETTER' : 'NO_SIGNIFICANT_DIFFERENCE';
  return { status, quiet, busy, weekendTrades, diff: Number.isFinite(diff) ? diff : null, ci, thresholds: { MIN_TRADES, MIN_MARKETS, MIN_WEEKEND } };
}

module.exports = { isQuiet, isWeekend, etParts, evaluate };
