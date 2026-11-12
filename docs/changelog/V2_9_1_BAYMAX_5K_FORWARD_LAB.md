# v2.9.1 BAYMAX 5K Forward Lab

## Purpose
This patch adds forward PAPER evidence for the frozen `BAYMAX_FINAL_5K` research model without retraining it, promoting it, or changing the six-bot Model Arena or the existing FINAL 1K Selectivity Lab. Historical OOS evidence and forward PAPER evidence remain separate experiments.

## Frozen model requirement
The lab loads `data/models/baymax-final-5k.json`. Identity, model version, authoritative 14-feature schema, and deterministic fingerprint must validate. Missing or invalid snapshots produce `BAYMAX5K_MODEL_UNAVAILABLE`; there is deliberately no fallback to `FINAL_CHALLENGER_1K`.

## Five policies
All policies use one contract, a $100 independent virtual bankroll, the same live executable quote/depth, the existing Kalshi fee model, and HOLD until actual settlement.

- `BAYMAX5K-8`: after-fee edge >= 8%.
- `BAYMAX5K-12`: after-fee edge >= 12%.
- `BAYMAX5K-20`: after-fee edge >= 20%.
- `BAYMAX5K-12Q`: after-fee edge >= 12% and entry price >= 5c.
- `BAYMAX5K-SNIPER`: after-fee edge >= 20%, entry >= 5c, and 90-120 seconds remaining.

The 12Q and SNIPER filters are forward tests of hypotheses discovered in Baymax-1K historical research; they are not training features and do not modify the model.

## Shared-prediction / shared-snapshot fairness
For each live FINAL evaluation, the application projects the current Grade-A feature vector to the authoritative 14-feature schema, computes `BAYMAX_FINAL_5K` once, freezes one live market snapshot, computes YES/NO opportunity and modeled fee once, then passes that identical opportunity to all five policies. Policies do not fetch, reprice, or recompute the model independently.

## Persistence and restart recovery
State is atomically persisted to `data/baymax-5k-forward-state.json`, including experiment start, first eligible ticker, model fingerprint, bankrolls, positions, trades, entry guards, funnel counters, depth metadata, and drawdown state. Open positions restore after restart. The normal settlement reconciliation queries Kalshi after close; an authoritative YES/NO result settles restored positions with `recoveredAfterRestart: true`. Unresolved markets remain pending.

## Metrics and funnel
Each policy reports cash/equity, trades, settled W-L, P&L, fees, EV, PF, ROI, average win/loss, average entry/raw/after-fee edge, max drawdown, open positions, no-trades, depth availability/average depth, and YES/NO splits. The funnel counts FINAL snapshots, valid opportunities, >=8%, >=12%, >=20%, >=12% plus >=5c, and the SNIPER combination.

## Dashboard and API
The existing Model Arena remains primary. A compact `BAYMAX 5K — FORWARD LAB` section shows POLICY / TRADES / W-L / P&L / EV / PF / DD, funnel, and open positions. `GET /api/baymax-5k-forward` returns JSON with `simulated: true` and `liveOrderCapable: false`.

## dotenv regression fix
`npm run baymax:5k` now runs `node -r dotenv/config scripts/baymax-5k.js`, so a normal local `.env` is loaded before Supabase initialization. Credential values are not printed.

## Safety boundary
The forward-lab module has no OrderExecutor, RiskManager, Kalshi create-order, real-account, Supabase-write, Collector-write, or training-label dependency. `TRADING_MODE=live` does not alter this. Actual Kalshi settlement is consumed only to score simulated positions.

## Limitations
This is forward PAPER, not proof of live profitability. It uses the live top-of-book/depth information available to the existing Arena simulator, but does not model queue priority or deeper multi-level execution. The 12Q/SNIPER policies are hypothesis tests and require meaningful independent settled-market sample sizes before interpretation.
