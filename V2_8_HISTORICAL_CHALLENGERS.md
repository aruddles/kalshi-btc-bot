# v2.8 Historical Challengers

v2.8 adds three shadow-only models: `EARLY_CHALLENGER`, `LATE_CHALLENGER`, and `FINAL_CHALLENGER`. Existing Grade-A 27-feature specialists are the Champions and are not replaced or mutated.

## Dataset and provenance
The historical runtime file defaults to `data/historical-ml-v1-1000-markets.jsonl` and is never packaged. Rows must be valid historical Grade-B JSONL with ticker, timestamp, binary settlement label, specialist regime, and a finite feature vector. Missing, empty, malformed, or incompatible datasets only disable challengers; Champions, Collector, ML PAPER and LIVE continue.

Historical Grade B is approximately one-minute reconstructed data without historical full order-book depth. It is not represented as equivalent to five-second Grade-A live observations.

## Shared 14-feature schema
Both Grade-B historical and Grade-A live observations are projected through the authoritative indexes `0,1,2,3,4,5,6,9,11,12,13,14,21,22`: spot_move, abs_move, move_dir, time_remaining, time_elapsed, volatility, high_vol, price, yes_spread, no_spread, combined_ask, dual_margin, trend_strength, trend_roc. Bot/strategy-state placeholders never enter Challenger vectors.

## Leakage-safe split
Grade-A live tickers are ordered chronologically. The newest ~15% are reserved as the untouched final test and the preceding ~15% as calibration. Older Grade-A live markets are training candidates. Historical Grade-B rows are training-only. Any historical ticker overlapping live calibration/test is removed; overlap with live training is deduplicated in favor of Grade A. No final-test ticker participates in training or calibration.

Each challenger trains only its EARLY (5-15m), LATE (2-5m), or FINAL (0-2m) regime using the existing stump ensemble family. Calibration is fitted only from the older Grade-A calibration markets. Raw and calibrated probabilities are preserved.

## Evaluation
Champion, Challenger and point-in-time Kalshi probabilities are compared on identical eligible observations from the Grade-A live final test only. Snapshot accuracy, Brier, log loss, observations and independent live-test market counts are exposed. Historical metrics cannot inflate the final benchmark.

## Forward shadow
Current live Grade-A features are projected into the same 14-feature schema. The current Champion, Challenger raw/calibrated probability and Kalshi probability are recorded. Exactly one forward call per specialist+ticker is persisted to `data/challenger-shadow-state.json`; repeated five-second snapshots do not count as independent forward wins. Actual settlement later annotates Champion/Challenger correctness.

## Safety
Challengers have no OrderExecutor, RiskManager, Kalshi create-order, or ML PAPER dependency. They cannot submit orders, change Champion ML PAPER entries/accounting, change PAPER/PAPER+, alter take-profit, modify Collector observations, or modify settlement labels. Promotion is intentionally out of scope and requires future forward evidence.

## Dashboard
The ML-first dashboard places Champion-vs-Challenger cards for FINAL and LATE prominently, keeps EARLY as research/high-variance, and exposes live calls, Grade-B dataset health, live-only test counts, and the 14-feature schema. Challenger results are explicitly SHADOW ONLY.

## Known limitations
Grade-B history has one-minute resolution and no full historical depth. Challenger final-test power is limited by the number of settled Grade-A live markets. The stump family is deliberately retained so this experiment isolates data quantity/schema effects rather than changing algorithms simultaneously.
