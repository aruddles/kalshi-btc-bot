# v2.6 ML Specialist Research

## Purpose
v2.6 moves the project toward an ML-first research platform while retaining the legacy PAPER/PAPER+ strategy as a control. All ML outputs remain shadow-only and cannot submit, block, resize, or modify LIVE orders.

## Whole-market chronology
The existing 70/15/15 chronological TRAIN/CALIBRATION/TEST split remains authoritative. Tickers are assigned before any specialist filtering, so snapshots from one ticker cannot cross datasets. Settlement outcome is target-only.

## Specialist models
Three independent stump ensembles are trained from the TRAIN observations in their own time regime: EARLY = 5–15 minutes, LATE = 2–5 minutes, FINAL = 0–2 minutes. FINAL owns the <30 second range. Each specialist calibration is fit only on CALIBRATION observations in the same regime. Specialist TEST metrics are compared with the GLOBAL model and point-in-time Kalshi on the same regime observations.

## Residual experiment
The residual experiment learns a leakage-safe logistic correction to the point-in-time Kalshi YES log-odds. Its parameters are fit on TRAIN only and its probability calibration is fit on CALIBRATION only. Rows without a valid historical Kalshi probability are excluded rather than invented. TEST reports compare residual, direct GLOBAL ML, and Kalshi.

## v2.5 edge audit
Edge direction is explicitly symmetric. `calibrated_ml - kalshi_yes > 0` is a YES opportunity; a negative value is a NO opportunity. Absolute edge selects the bucket. The dashboard/evaluation now reports YES and NO opportunity counts. Therefore a falling directional-accuracy curve at larger disagreement is retained if the production dataset reproduces it; v2.6 does not invert the metric merely because the result is unfavorable.

## Market-level audit
v2.5 used the final eligible snapshot, which can be extremely close to settlement. v2.6 production evaluation uses the latest snapshot with at least 30 seconds remaining for each ticker. Markets without such a snapshot are excluded and counted. The old helper remains only for regression compatibility and is not used by v2.6 evaluation.

## Data health
Telemetry reports total markets/snapshots, a rolling latest-30-market class balance and snapshot count, history span, and EARLY/LATE/FINAL snapshot coverage. Historical rows are retained; these diagnostics make recency and regime coverage visible instead of assuming older data is automatically useful.

## Safety
Specialists and residual outputs are research telemetry only. The ML scorer continues to return `mlAdjustment: 1`, `mlBlocked: false`, and the original strategy edge. No ML module imports or calls Kalshi live order submission. Existing RiskManager, OrderExecutor, LIVE confirmation, settlement, PAPER/PAPER+, and take-profit behavior are unchanged.

## Limitations
The residual experiment is intentionally simple and should be treated as a benchmark, not a production trading model. Specialist sample sizes can be small. Historical canonical snapshots do not contain enough guaranteed executable fill/fee data to fabricate P&L. Real metrics require the configured Supabase dataset at runtime.
