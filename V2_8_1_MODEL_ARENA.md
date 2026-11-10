# v2.8.1 Model Arena

## Purpose
v2.8.1 turns the forward ML PAPER layer into a fair six-bot arena without changing Champion/Challenger training or LIVE execution.

## Six independent PAPER HOLD bots
EARLY_CHAMPION, EARLY_CHALLENGER, LATE_CHAMPION, LATE_CHALLENGER, FINAL_CHAMPION, and FINAL_CHALLENGER each own an independent virtual bankroll (default $100), positions, settled trades, entry guards, P&L and decisions. A position in one portfolio never blocks another portfolio.

## Fair economic rules
All six use one contract by default, the point-in-time executable YES/NO ask, the existing modeled Kalshi taker-fee function, a 5% minimum after-fee edge by default, displayed top-level depth when available, and HOLD to actual Kalshi settlement. There is no take-profit, stop-loss, or managed exit in the Arena. The only intended Champion/Challenger difference within a regime is model probability.

## Decision rule
For YES: `P_model(YES) - YES ask - modeled fee`. For NO: `P_model(NO) - NO ask - modeled fee`. The larger positive after-fee edge is selected and must meet the configured threshold. Otherwise the bot records NO TRADE.

## State migration and persistence
Arena state is atomically persisted to `data/model-arena-state.json`. On first run, if Arena state does not exist, `data/ml-paper-state.json` is read once and durable Champion trades/positions are distributed by their existing EARLY/LATE/FINAL specialist attribution. Existing specialist cash is preserved when present. Challenger portfolios start with no fabricated history. Entered bot/ticker guards persist across restart.

## Leaderboard and promotion readiness
The leaderboard sorts primarily by realized after-fee P&L and then expectancy per settled trade. Promotion is never automatic. A model is only marked REVIEW ELIGIBLE when it has at least 50 independent settled PAPER trades, positive expectancy, profit factor above 1, and positive realized P&L. Offline metrics remain context, not promotion authority.

## Same-market comparisons
For each regime/ticker the Arena records Champion-only, Challenger-only, both-same-side, both-opposite-sides, or neither-traded. After actual settlement it records whether Champion, Challenger, or neither made the better directional trade decision.

## Dashboard
The main page is now ML-first: BTC/target chart; FINAL Champion vs Challenger; LATE Champion vs Challenger; all open Arena positions; six-bot leaderboard; EARLY research/high-variance pair; live console. Advanced research and legacy execution controls are collapsed under Diagnostics / Legacy Execution.

## Historical dataset dependency
Challenger models still depend on external `data/historical-ml-v1-1000-markets.jsonl`. The dataset is not packaged. If the Challenger model is unavailable, no Challenger Arena entry is evaluated; Champions and the rest of the bot continue safely.

## Safety boundaries
`lib/model-arena.js` has no OrderExecutor, RiskManager, Kalshi create-order, or LIVE account dependency. Arena accounting is simulation only even when `TRADING_MODE=live`. Arena settlement consumes actual Kalshi result as read-only data. PAPER P&L never writes Collector observations, `label`, or `settled_result` training targets.

## Configuration
- `ML_PAPER_ENABLED=true` enables the Arena simulation loop.
- `MODEL_ARENA_STARTING_CASH=100` sets each bot's independent starting bankroll.
- `MODEL_ARENA_CONTRACTS=1` sets default accepted-trade size.
- `ML_PAPER_MIN_EDGE=0.05` remains the common minimum after-fee edge.
- `ML_PAPER_MAX_EXPOSURE=10` remains the per-entry exposure ceiling.

## Why PAPER competition is not LIVE readiness
Forward simulated after-fee results are evidence about model/entry quality, but do not prove real fill quality, latency, queue position, production robustness, or sufficient sample size. Challenger promotion and any connection to LIVE execution remain out of scope.
