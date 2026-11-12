# ML Data Collector v2

This patch expands ML Training v1 from **filled-trade-only observations** to a trade-independent KXBTC15M market dataset.

## Behavior

- Samples each active KXBTC15M market every 5 seconds by default.
- Sampling does **not** require an order, fill, or live trading.
- Each snapshot is a canonical YES-outcome example with a deterministic ID:
  `market:<ticker>:<5-second-bucket>`.
- Every new row starts with `label = NULL`.
- Only the actual Kalshi market result labels the row:
  - settlement YES -> `label = 1`
  - settlement NO -> `label = 0`
- Take-profit, P&L, exits, and the old strategy's decision do not affect snapshot labels.
- Unsettled tickers are recovered from Supabase after restart and retried until Kalshi reports a result.
- The old filled-trade observations from ML Training v1 remain intact for audit/history, but model training uses only `MARKET_SNAPSHOT_YES` rows so target semantics cannot mix.

## Leakage prevention

Training/validation is split by whole Kalshi ticker. Snapshots from one 15-minute market can never appear in both training and validation. Normalization parameters are learned from training markets only.

## Recommended operation

Run `TRADING_MODE=paper` while collecting data if you do not want the existing strategy risking money. The collector uses live market feeds and real Kalshi settlements in either PAPER or LIVE mode.

## Supabase migration

ML Training v1 columns are still required. v2 only adds an optional composite index for faster settlement labeling; see the bottom of `lib/supabase-migrations.sql`.
