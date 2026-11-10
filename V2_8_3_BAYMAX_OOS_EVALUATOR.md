# v2.8.3 BAYMAX OOS Evaluator

BAYMAX Phase 1 is an offline, modeled historical out-of-sample exam for the exact fitted `FINAL_CHALLENGER_1K`. It does not retrain, promote, trade, or modify Model Arena / Selectivity Lab state.

## Frozen model reproduction
The v2.8 Challenger is not trained from the 1K historical file alone: it combines historical Grade-B training rows with leakage-safe older Grade-A live rows and calibrates on separate Grade-A live markets. Therefore v2.8.3 exports the actual fitted FINAL Challenger stump model and calibration to `data/final-challenger-1k-model.json`. The snapshot records the authoritative 14 feature indexes/names, model parameters, calibration parameters, training counts/identity, and SHA-256 fingerprint. Baymax refuses to claim equivalence if this snapshot is missing.

## Inputs and zero overlap
Defaults:
- training identity dataset: `data/historical-ml-v1-1000-markets.jsonl`
- exam: `data/baymax-oos-v1-3989-markets.jsonl`
- frozen model: `data/final-challenger-1k-model.json`

Before evaluation the complete ticker sets are compared. Any overlap aborts the run; overlap is never silently removed.

## Replay and policies
Only FINAL (0-2 minutes, including <30 seconds) rows are replayed in timestamp order. For each historical snapshot the frozen Challenger probability is computed once, the point-in-time YES/NO asks are derived once from stored historical bid/ask data, side/fee/after-fee edge are computed once, and the identical opportunity is offered to 1%, 3%, 5%, 8%, and 12% policies. Each policy can enter a ticker once and holds to actual settlement.

Results are labeled **MODELED HISTORICAL OOS — NOT LIVE EXECUTION**. Historical Grade-B data has no guaranteed queue position or full executable depth. No depth/fill/quote is invented. Missing required pricing is skipped and reported.

## Fees and metrics
Fees use the same `estimateTakerFeeDollars` implementation used by PAPER Arena. A winning one-contract modeled trade pays $1; a loser pays $0; net P&L is payout minus historical entry price minus modeled fee.

Each threshold reports trade frequency, W-L, win rate, modeled net P&L, fees, EV/trade, average win/loss, PF, ROI, max drawdown, entry/edge averages, YES/NO breakdown, price buckets, edge buckets, FINAL time buckets, chronological quartile stability, and cumulative P&L.

## Outputs
`data/baymax/summary.json`, `data/baymax/trades.jsonl`, and `data/baymax/cumulative-equity.json` are research outputs and are excluded from source packaging.

Run:
```bash
npm run baymax:oos
```
Overrides: `--training`, `--oos`, `--model-snapshot`, `--out`.

## Reproducibility and safety
Identical datasets + model snapshot produce identical decisions/metrics; only output run timestamp/path metadata may differ. OOS labels are not passed to prediction. The evaluator imports no OrderExecutor, RiskManager, server, Collector, Supabase writer, Arena state, or Selectivity state. It cannot submit orders or modify labels/runtime state.

Historical modeled EV is not live-forward PAPER EV and does not prove LIVE profitability. It is an offline generalization exam under reconstructed one-minute Grade-B pricing limitations.
