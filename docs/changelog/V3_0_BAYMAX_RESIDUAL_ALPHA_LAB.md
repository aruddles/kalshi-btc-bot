# v3.0 BAYMAX 2.0 — Residual Alpha Lab

## Purpose
BAYMAX_RESIDUAL_V1 demotes the old “predict settlement independently, subtract Kalshi” trading thesis to a baseline and asks a narrower question: **does Grade-A market state contain incremental information about Kalshi's point-in-time forecast error?** It is offline research only and creates no PAPER or LIVE portfolio.

## Statistical formulation
v3.0 uses the conditional-probability formulation, not direct residual regression. The existing gradient-boosted stump classifier predicts `P(YES | Kalshi probability + market state)`. The reported predicted residual is `adjusted P(YES) - point-in-time Kalshi P(YES)`. The realized residual is `actual settlement (1/0) - point-in-time Kalshi P(YES)`. This is deliberately not described as regression.

## Grade-A dataset and features
Only settled canonical Grade-A `MARKET_SNAPSHOT_YES` observations loaded from the existing Supabase training pipeline are eligible. FINAL remains the authoritative 0–2 minute regime. Rows without valid ticker/timestamp/settlement/Kalshi probability/features are rejected and reported.

The exact feature vector is the existing authoritative 14-feature market-only projection: `spot_move, abs_move, move_dir, time_remaining, time_elapsed, volatility, high_vol, price, yes_spread, no_spread, combined_ask, dual_margin, trend_strength, trend_roc`. `price` is the point-in-time Kalshi YES probability used by the existing Challenger system. Bot P&L, balance, contracts, strategy edge/flags, model probability, future observations and settlement state are excluded.

## Leakage and market independence
Tickers are sorted chronologically and split as whole markets: oldest ~70% TRAIN, next ~15% CALIBRATION, newest ~15% untouched TEST. No ticker crosses partitions. Fitting/calibration deterministically cap each market at 12 evenly spaced snapshots so a market with more snapshots cannot dominate solely due to row count. Conclusions always report independent market counts as well as observations.

## Evaluation
The exact untouched TEST rows are used for Kalshi, BAYMAX_FINAL_1K (when its frozen snapshot exists), BAYMAX_FINAL_5K (when valid snapshot exists), and BAYMAX_RESIDUAL_V1. Primary metrics are Brier score and log loss, with accuracy as secondary context.

Residual research includes predicted-vs-realized residual buckets, |residual| thresholds 3/5/8/12/20%, separate positive/YES and negative/NO directions, Kalshi probability regions, FINAL 0–30/30–60/60–90/90–120 second regions, chronological quartiles, and deterministic whole-market bootstrap confidence intervals.

## Promotion gate
Statuses are `INSUFFICIENT_DATA`, `NO_INCREMENTAL_ALPHA`, `WEAK_INCREMENTAL_SIGNAL`, or `PROMISING_INCREMENTAL_ALPHA`. Promising requires improved untouched-test Brier versus Kalshi, no material log-loss deterioration, positive residual correlation, sufficient independent markets, and supportive market-clustered evidence. This status never promotes or trades the model.

## Snapshot/cache
A successful model is stored at `data/models/baymax-residual-v1.json` with architecture, exact features, train/calibration market hashes, fitted parameters, calibration, version, and deterministic fingerprint. It is excluded from release ZIPs. A cache is reused only when identity/schema/fingerprint and current train/calibration market hashes validate.

## CLI and outputs
Run `npm run baymax:residual`. Dotenv is preloaded automatically. The command does not start the trading server. It writes `data/residual/summary.json` and `data/residual/test-predictions.jsonl`; generated research outputs are excluded from packaged releases.

## Safety and limitations
There is no PAPER portfolio, OrderExecutor, RiskManager execution, real balance, create-order, Collector write, or Supabase-label mutation path. Actual Kalshi settlement remains the only label. Frozen Baymax baseline metrics are omitted if their snapshots are unavailable rather than reconstructed differently.

This is observational predictive research, not proof of executable alpha. Snapshot correlation within markets, changing market regimes, limited independent Grade-A markets, top-of-book execution differences, and Kalshi microstructure can all limit generalization. Historical Grade-B data is intentionally excluded from primary residual training in v3.0.
