# v2.9.2 Specialist 5K Scaling Lab

This release extends the controlled historical-data scaling experiment to EARLY and LATE without promoting or trading either 5K model. `npm run specialists:5k` loads dotenv automatically, validates the external 1K and 4,989-market historical datasets, and uses the existing 14-feature market-only projection and MLPipeline stump/calibration primitives.

EARLY uses the authoritative 300–900 second regime; LATE uses 120–<300 seconds. For each specialist, only Grade-A settled markets newer than the 5K historical end date are eligible. Whole tickers are split chronologically into older live training support, calibration, and newest untouched test. Test tickers are prohibited from historical training, live training, and calibration.

The incumbent 1K semantics are reconstructed with the same 1K historical data, identical Grade-A support/calibration split, feature schema, and model family. The 5K model changes only the historical training scale. The 5K fitted models are cached as `data/models/baymax-early-5k.json` and `data/models/baymax-late-5k.json`, keyed by dataset SHA-256, schema, model identity/version, and deterministic fingerprint.

The same eligible Grade-A test rows are scored by the incumbent, 5K challenger, and Kalshi. Metrics are accuracy, Brier, and log loss, with relative 5K-vs-1K improvements and 5K-vs-Kalshi gaps. Status is `IMPROVED`, `MIXED`, `NOT_IMPROVED`, or `INSUFFICIENT_HOLDOUT`; no status promotes a model automatically.

This is research-only. It creates no PAPER portfolio, has no OrderExecutor/RiskManager/live-order path, and does not write Collector observations or labels. FINAL-5K, both existing selectivity labs, Baymax OOS, Baymax 5K Forward Lab, and all six Model Arena portfolios remain unchanged. A poor LATE result is reported honestly; trajectory-aware redesign is a future experiment, not part of this release.
