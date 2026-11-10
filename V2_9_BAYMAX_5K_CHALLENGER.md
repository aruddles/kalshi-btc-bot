# v2.9 — BAYMAX FINAL 5K Challenger

## Purpose
BAYMAX Phase 2 tests one controlled question: whether increasing historical FINAL training data from the incumbent 1K historical dataset to `historical-ml-v3-5000-markets.jsonl` improves probability quality. It does not promote or trade the 5K model.

## Models
- `BAYMAX_FINAL_1K` is the incumbent frozen `FINAL_CHALLENGER_1K` snapshot exported by v2.8.3. It is loaded read-only and is never retrained or overwritten by the 5K command.
- `BAYMAX_FINAL_5K` is FINAL-only and uses the same `MLPipeline._fitStumpModel`, `_predictStumpModel`, and `_fitCalibration` primitives as the historical Challenger family.

Both use exactly the market-only indexes `0,1,2,3,4,5,6,9,11,12,13,14,21,22`: spot_move, abs_move, move_dir, time_remaining, time_elapsed, volatility, high_vol, price, yes_spread, no_spread, combined_ask, dual_margin, trend_strength, trend_roc.

## Training and untouched live exam
The 5K historical file is external runtime data. Only valid historical FINAL rows are projected into the 14-feature schema. The historical file's latest timestamp defines the historical boundary. Settled Grade-A live FINAL rows must be strictly newer than that boundary.

Those newer live tickers are ordered chronologically by whole ticker and split 70% older live training / 15% calibration / 15% newest untouched test. No final-test ticker may occur in live training, calibration, or the historical 5K training tickers. The final comparison uses one identical subset of test observations with valid point-in-time Kalshi probability for 1K, 5K, and Kalshi.

The old 3,989-market Baymax OOS set is NOT used to evaluate 5K because it is contained in the expanded historical training universe. `npm run baymax:oos` remains unchanged and valid only for the frozen 1K incumbent.

## Metrics
The comparison reports accuracy, Brier score, and log loss for BAYMAX_FINAL_1K, BAYMAX_FINAL_5K, and Kalshi, plus relative 5K-vs-1K Brier/log-loss improvement and the 5K-vs-Kalshi gap. Lower Brier/log loss is better. Accuracy alone is not a promotion criterion.

## Snapshot/cache
The fitted 5K snapshot defaults to `data/models/baymax-final-5k.json`. It contains model/calibration parameters, feature schema, historical dataset identity/SHA-256, historical and eligible Grade-A fitting counts, model version, creation timestamp, and deterministic model fingerprint. It is reused only when model version, feature schema, dataset SHA-256, and fingerprint validate. Otherwise it is retrained safely.

Runtime-generated snapshots are excluded from release ZIPs.

## CLI
```bash
npm run baymax:5k
```
Defaults:
- historical: `data/historical-ml-v3-5000-markets.jsonl`
- incumbent: `data/final-challenger-1k-model.json`
- 5K snapshot: `data/models/baymax-final-5k.json`
- output: `data/baymax-5k/summary.json`

Supabase must be configured because the final exam must be genuine settled Grade-A live data. If no eligible live holdout exists, the command fails safely instead of fabricating an exam.

## Safety
BAYMAX_FINAL_5K is research-only. The CLI does not start the server and has no OrderExecutor, RiskManager execution, Kalshi create-order, Arena accounting, Selectivity Lab accounting, Collector-write, or ML-label mutation path. Existing Model Arena and FINAL Selectivity Lab remain unchanged; the lab stays attached to FINAL_CHALLENGER_1K.

## Future work
If 5K demonstrates better probability quality on untouched Grade-A markets, a later controlled patch can test selectivity thresholds (for example 5/8/12/20%) and reliability filters. Those hypotheses are not hardcoded into this model comparison.

## Limitations
The quality of the comparison is bounded by the number and class balance of genuinely newer settled Grade-A FINAL markets. The 1K incumbent and 5K challenger were fitted at different project times; the frozen 1K snapshot is therefore the authoritative incumbent rather than a retrospective retrain. No result from this evaluator alone proves LIVE profitability.
