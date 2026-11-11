# v3.3 — Composite USD reference feed (BRTI proxy)

## Why
KXBTC15M settles on CF Benchmarks' BRTI: YES iff the 60-second BRTI average before close is at or above `floor_strike`, the 60-second BRTI average before open. BRTI is built from USD order books on constituent exchanges. The bot priced everything off Binance BTCUSDT, which is not a constituent and is quoted in USDT. So both its strike and its "current price" carried a venue and USDT/USD basis.

## What
- `lib/reference-price.js`: parsers for Coinbase (`ticker`), Kraken v2 (`ticker`, `event_trigger: bbo`) and Bitstamp (`order_book_btcusd`). The composite is the median of fresh mids (≤5s old). Venues more than 0.5% from the median are dropped, and at least two venues are required.
- `bot/usd-reference-feed.js`: WebSocket client with per-venue reconnect/backoff and a 30s stall watchdog. Samples once a second into a 1-hour `priceHistory` and exposes the same surface as `BinanceFeed`. Market data only.
- `usd-reference-feed` skill, started with the agent (`USD_REFERENCE_ENABLED=false` disables it).
- **Strike accuracy tracking (Observed, live):** for every market, after it opens, the 60s pre-open average from the composite feed and from Binance is compared with Kalshi's `floor_strike`. See `GET /api/reference` → `strikeAccuracy`. This directly measures which feed reproduces BRTI better. After 20 markets, the median composite error is used as a basis correction (`bias`).
- **`settlementProbabilityFromReference` (Hypothesis, shadow only):** the v3.1 settlement model, but against Kalshi's official `floor_strike` with the composite feed as current price. It needs no pre-open observation. It is logged as `collector_meta.brti_p`, with `reference_price` and `reference_bias`. The collector version stays `live-collector-v3.1`, so the pre-registered evaluation keeps its rows.
- `npm run settlement:shadow-eval` adds a **secondary** BRTI_PROXY section (rows with `brti_p` only). The frozen primary comparison and status rule are unchanged.
- `PROB_MODEL=settlement_brti` lets it drive trading. **Fix:** `PROB_MODEL` was documented in `.env.example` but never passed into the config, so `settlement_avg` had no effect. It is now read, and unknown values fall back to `gbm_point`.
- Dashboard: when the feed is live, the price chart plots the composite against `floor_strike` ("BRTI PROXY"). Otherwise it falls back to Binance against the Binance open price. TARGET shows the official strike when Kalshi provides it.

## Status
Shadow only. Before enabling `settlement_brti`:
1. `strikeAccuracy` over ≥100 markets should show the composite much closer to `floor_strike` than Binance.
2. The secondary shadow evaluation should show BRTI_PROXY beating KALSHI_MID on ≥200 settled markets.

## Follow-up fixes (2026-11-11)
- `getSettlementShadowRows` paged with OFFSET while ordering by the unindexed `ts`, which hit Supabase's statement timeout. It now keyset-pages on `id`, retries a page on a timeout, and sorts the result in memory. An optional partial index is in `lib/supabase-migrations.sql` (`idx_ml_features_shadow_rows`).
- BRTI_PROXY rows were only scored when GBM and SETTLEMENT were also present. Those models need a Binance tick within 2.5s of market open, which is often missing (see below), so BRTI rows are now scored on their own. They are compared with KALSHI_MID on all rows, and with GBM where it exists. The primary comparison is unchanged.
- **Observed:** Binance.US `btcusdt@bookTicker` produced 7 ticks in 45s, with gaps up to 26s. Of the 125 live markets collected since v3.1, 51 had no Binance open price. Those markets had no GBM probability and were skipped for trading. Only 8 markets had the settlement model's 30 pre-open ticks.
