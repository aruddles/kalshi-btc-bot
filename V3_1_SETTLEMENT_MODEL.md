# v3.1 — Normal-CDF fix, settlement-aware model, live collector fix

## 1. Critical bug fix: normal CDF (Observed)
Every GBM probability in the bot (`agents/.../probability-model.js`, `bot/strategy.js`, `backtest/backtest.js`, `scripts/simulate-kalshi-capture.js`) used a CDF that applied the A&S 7.1.26 *erf* coefficients to `x` together with the normal pdf factor. Result: Φ(0) = 0.80, with a jump to 0.20 just below zero.

| Situation (σ15m = 0.15%) | Old P(UP) | Correct |
|---|---:|---:|
| BTC +$5 vs strike, 10m left | 0.81 | 0.52 |
| BTC −$20, 10m left | 0.16 | 0.42 |
| BTC +$50, 5m left | 0.92 | 0.76 |

Now one implementation, `lib/normal.js` (max abs error 7e-8). **Consequences:**
- All prior GBM directional/PAPER results and the synthetic backtest "≈6% overconfidence" finding are invalid as evidence of model edge; most claimed edges were this artifact.
- Supabase features 7 (`edge`) and 8 (`model_prob`) before v3.1 were computed with the broken CDF. The 14-feature market-only projection (BAYMAX, residual lab) does not use them; the full-feature models do.
- Expect far fewer directional signals after the fix. That is intended.

## 2. Collector staleness fix (Observed)
`state.model` is only updated inside `TRADING_WINDOW`. The collector copied it, so FINAL-regime (0–120s) Grade-A snapshots carried volatility, high_vol, trend_strength, and trend_roc frozen several minutes earlier, and model_prob could belong to a different market. The collector now computes these per market at snapshot time, from the same sources. Rows are tagged `collector_meta.collector_version = live-collector-v3.1`; untagged rows predate the fix.

**Migration** (run once): `ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS collector_meta JSONB;` (also in `lib/supabase-migrations.sql`). Without it, the collector logs one warning and keeps writing rows without the metadata.

## 3. Settlement-aware model (Hypothesis, shadow only)
KXBTC15M resolves YES iff the 60s CF BRTI average before close ≥ the 60s average before open (`floor_strike`). The legacy model uses a single Binance tick at open and variance σ²t. `lib/settlement-model.js` uses:
- **Strike:** the Binance 60s average over the pre-open minute (same construction, same units). `floor_strike` is now parsed; strike − floor_strike is logged as `strike_basis` (USDT/USD and venue basis).
- **Variance:** σ²((t−60)+20) for t ≥ 60s. In the final minute, the already-observed part of the average is locked in and the remaining variance is σ²t³/(3·60²).
- Fail-safe: returns null if the pre-open minute wasn't observed.

Validated against a Monte Carlo of the actual averaging rule (tests). By default it is **shadow only**: it's computed and logged as `collector_meta.settlement_p` beside `gbm_p` and the Kalshi quote. `PROB_MODEL=settlement_avg` makes it drive trading. Don't enable that until the evaluation below passes.

## Pre-registered evaluation (frozen before any v3.1 data)
`npm run settlement:shadow-eval` (read-only) → `data/settlement-shadow/summary.json`.
- Data: settled v3.1-tagged snapshots only, max 12 per market.
- Primary: Brier, SETTLEMENT vs GBM_POINT, all regimes, market-clustered bootstrap 95% CI. Secondary: vs KALSHI_MID, per regime (FINAL/LATE/MID/EARLY), log loss.
- Status: `INSUFFICIENT_DATA` (<200 markets) / `SETTLEMENT_BETTER_THAN_GBM` / `NO_SIGNIFICANT_DIFFERENCE` / `SETTLEMENT_WORSE_THAN_GBM`.
- Beating GBM is a model-quality result, not tradable edge. Edge additionally requires beating KALSHI_MID after fees on independent forward data.

## Status
Bug fixes: done. Settlement model: shadow collection only, awaiting ≥200 forward markets.
