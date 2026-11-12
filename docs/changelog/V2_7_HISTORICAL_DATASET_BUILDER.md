# v2.7 Historical Dataset Builder v1

## Purpose
Accelerate independent-market ML research without contaminating the production `ml_features` dataset. Historical reconstruction writes only to `ml_historical_staging`; the production trainer remains live-data-only.

## Sources and fidelity
- Kalshi archived KXBTC15M markets: settlement, strike/target, open/close timestamps.
- Kalshi archived 1-minute candlesticks: point-in-time YES bid/ask/traded-price data.
- Coinbase Exchange BTC-USD 1-minute candles: BTC-side price history.
- Historical full order-book depth is not available from Kalshi's official archive and is never synthesized.

Rows are `quality_grade=B`, `source=historical`, `resolution_seconds=60`. The builder explicitly marks strategy-state features that cannot be faithfully reconstructed: `edge`, `model_prob`, `contracts`, `recent_wr`, `recent_pnl`, `streak`, and `balance`. Neutral placeholders keep the current 27-column vector shape, but these rows are staging-only until a controlled feature-subset experiment is implemented.

## Specialist sampling
Each settled market is sampled at fixed pre-close offsets: 12m, 10m, 8m, 6m, 5m, 4m, 3m, 2m, 90s, 60s, 30s where point-in-time source data exists. Rows are tagged EARLY/LATE/FINAL.

## Safety / leakage
- Only actual Kalshi `result` supplies the label: YES=1, NO=0.
- All feature timestamps precede close/settlement.
- Missing BTC/Kalshi candles cause the sample to be skipped; no silent forward fill.
- The importer has no dependency on OrderExecutor, RiskManager, paper broker, or live order submission.
- Dry-run is the default.

## Supabase staging migration
Run the appended SQL in `lib/supabase-migrations.sql` once to create `ml_historical_staging` before using `--write`.

## Commands
Dry-run 100 archived markets and save JSONL locally:

```bash
npm run historical:ml -- --limit 100
```

Choose an output path:

```bash
npm run historical:ml -- --limit 500 --out data/kxbtc15m-history.jsonl
```

After reviewing the quality report and creating the staging table, write idempotently to Supabase:

```bash
npm run historical:ml -- --limit 500 --write
```

Stable observation IDs are `historical:<ticker>:<minute bucket>`, so reruns upsert instead of duplicating rows.

## Admission policy
Do not train production models from staging yet. The next research step is a controlled comparison on untouched LIVE markets:
1. live Grade-A only;
2. live Grade-A + historical Grade-B using only mutually available market-derived features;
3. recency-weighted A+B.
Historical data is admitted only if it improves forward live Brier/log loss and after-fee paper expectancy.
