# v2.4 — ML Loader + ML Intelligence Dashboard

## Fix: Supabase pagination
`getTrainingData()` now pages through labeled `MARKET_SNAPSHOT_YES` rows in 1,000-row ranges until exhaustion. This removes the silent 1,000-row training cap and the previous 10,000-row caller cap. An optional explicit limit is still supported.

With the user's current Supabase counts, the next startup should load roughly 16,392 labeled snapshots across 98 settled markets (subject to rows added since that check).

## ML telemetry
The pipeline now exposes dataset class counts, training/validation market counts, snapshot validation accuracy, market-level validation accuracy, Brier score, training status, model version, and last-trained timestamp through `/api/ml`.

The dashboard includes an **ML Intelligence** panel with those metrics plus progress toward 250 settled markets.

## Validation
- Added pagination regression coverage using 2,507 mocked rows across three pages.
- Added explicit-limit pagination coverage.
- Added dashboard telemetry contract coverage.
- No live execution, PAPER/PAPER+, risk, settlement, or ML labeling behavior was changed.
