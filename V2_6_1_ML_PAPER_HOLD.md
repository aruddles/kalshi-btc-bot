# v2.6.1 ML PAPER HOLD

## Purpose
ML PAPER HOLD is an isolated forward paper-trading runtime for evaluating live specialist predictions against current KXBTC15M executable asks. It is research-only and never routes through OrderExecutor or Kalshi order submission.

## Entry calculation
For each live market the v2.6 time router supplies EARLY, LATE, or FINAL when available; otherwise calibrated GLOBAL is the fallback. GLOBAL and RESIDUAL probabilities are recorded as research context. Both sides are evaluated symmetrically:

- YES edge = P_ml(YES) - YES executable ask - estimated one-contract fee
- NO edge = (1 - P_ml(YES)) - NO executable ask - estimated one-contract fee

The side with the larger positive after-fee edge is eligible only when it meets `ML_PAPER_MIN_EDGE` (default `0.05`, or 5 percentage points). Missing executable asks do not produce trades. Displayed ask depth caps size when available.

## Fees and bankroll
The runtime reuses the Kalshi taker-fee estimator and market fee multiplier. The exact multi-contract fee is included in reserved entry cost and realized P&L. It owns a separate virtual bankroll (`ML_PAPER_STARTING_CASH=100` by default), with independent max-contract and max-exposure controls. It never reads or mutates PAPER, PAPER+, or LIVE cash.

## HOLD settlement
v2.6.1 intentionally has no take-profit, stop-loss, sell, or managed-exit method. Positions remain open until a read-only Kalshi market fetch reports actual `yes` or `no` settlement. A winning contract pays $1 and a losing contract pays $0. Realized P&L is payout minus the durable fee-inclusive entry cost.

## Specialist selection
The live v2.6 router remains authoritative: EARLY (5-15m), LATE (2-5m), FINAL (0-2m). The active specialist's calibrated probability is primary when available; calibrated GLOBAL is a safe fallback. RESIDUAL is recorded but is not automatically selected based on historical TEST performance.

## Persistence and restart behavior
`data/ml-paper-state.json` persists cash, realized P&L, open positions, settled trades, entered tickers, counters, and the last decision. Open positions therefore settle without transient order objects. Entered tickers persist across restarts, enforcing at most one ML PAPER entry per ticker and preventing duplicate settlement/trades.

## Dashboard
The `ML PAPER — HOLD` panel shows ACTIVE/OFF, bankroll/equity/P&L/exposure, trade analytics, current/last decision, active model, probabilities, executable ask, edge/fee/net edge, open position mark, and recent settled trades. It is labeled `SIMULATED — NO REAL ORDERS`.

## Training-label safety
The runtime has no Supabase or ML collector dependency and never writes `label`, `settled_result`, `predicted_side`, or training observations. Actual Kalshi settlement remains the sole canonical training target. ML PAPER P&L and legacy take-profit outcomes cannot define ML labels.

## Safety boundary
`lib/ml-paper-hold.js` has no OrderExecutor, RiskManager, create-order, or place-order dependency. `TRADING_MODE=live` does not change this. The MasterAgent integration passes market/prediction data into the simulator and uses the Kalshi client only for read-only settlement fetches.

## Configuration
- `ML_PAPER_ENABLED=false`
- `ML_PAPER_STARTING_CASH=100`
- `ML_PAPER_MIN_EDGE=0.05`
- `ML_PAPER_MAX_CONTRACTS=5`
- `ML_PAPER_MAX_EXPOSURE=10`
- `KALSHI_TAKER_FEE_RATE` and market fee multiplier feed the existing fee estimator.

## Known limitations
This release is deliberately HOLD-only. It does not model queue position, slippage beyond using the displayed executable ask, partial fills across multiple book levels, or managed exits. If top-level displayed depth is absent, size falls back to the configured contract cap rather than fabricating deeper book liquidity. Unrealized dashboard P&L is a mark only; settlement P&L is authoritative.
