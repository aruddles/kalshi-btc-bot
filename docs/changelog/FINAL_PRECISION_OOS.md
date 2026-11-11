# FINAL PRECISION — Independent Grade-A OOS Evaluator

This read-only evaluator validates the frozen discovery rule without threshold search or model retraining. The discovery result (29 trades, +$3.525, +$0.122 EV) is explicitly treated as discovery-only and is never pooled with holdout results.

It requires `data/model-arena-state.json` to identify every FINAL_CHALLENGER discovery ticker and an enriched `data/final-challenger-1k-model.json` containing the exact Grade-A training/calibration ticker sets used by the frozen model. If either provenance source is absent, evaluation aborts safely. Current bot startup exports these ticker identities when the 1K Challenger is fitted.

The independent holdout is settled Grade-A FINAL data from Supabase after excluding model-training, model-calibration, and discovery tickers. Canonical snapshot feature 9 supplies the point-in-time YES executable price; feature 13 supplies combined ask, allowing the contemporaneous NO ask to be recovered without future data. Invalid quotes/features are excluded and reported.

Policies are frozen: ORIGINAL (existing >=5% after-fee entry), EDGE_8_20, NO_EXTREME_P, PRECISION (8% inclusive to 20% exclusive and model P(YES) strictly between 5% and 95%), and EXTREME_20_PLUS. One contract, existing Kalshi fee model, one entry per policy/ticker, HOLD to authoritative settlement.

`npm run final:precision-oos` loads dotenv, reads Supabase, and writes `data/final-precision-oos/summary.json` plus `trades.jsonl`. It never starts the server or mutates Arena, Selectivity, Baymax Forward, Collector, Supabase, labels, or trading state.

Whole-market bootstrap uses a deterministic seed. Status is one of PRECISION_REPLICATED, PRECISION_WEAK_SIGNAL, PRECISION_FAILED, or INSUFFICIENT_INDEPENDENT_HOLDOUT. Even a retrospective replication still requires prospective forward validation.
