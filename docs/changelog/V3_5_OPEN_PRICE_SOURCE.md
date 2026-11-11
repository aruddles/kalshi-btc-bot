# v3.5 — Opening price from the composite feed (fix for sparse Binance.US)

## Problem (Observed)
The GBM compares the BTC price now with the price at market open. The open was recorded only when Binance had a tick within 2.5s of `openTime`. Binance.US `btcusdt@bookTicker` produced 7 ticks in 45s, with gaps up to 26s. As a result, 51 of 125 live markets since v3.1 had no opening price. Those markets had no GBM probability, the collector logged blank `gbm_p`, and the signal generator **skipped them for trading**.

## Fix
`lib/market-prices.js`, used by market discovery, the signal generator, the ML scorer and the collector:
- `recordOpenPrice`: records the open once per market from the composite USD feed (1 sample/s, 3 venues). If that feed has no sample within 2.5s, it falls back to Binance. A later price is never substituted for a missed open. The source is stored in `marketOpenPriceMeta` (`usd_reference_at_market_open` | `binance_at_market_open`).
- `marketPriceInputs`: returns the opening price and the **current price from the same feed**, plus that feed for volatility. The two feeds differ by tens of dollars, so they are never mixed. If the feed that recorded the open is unhealthy, the market is skipped.
- The signal generator no longer stops entirely when Binance has no price; only the Binance-based `settlement_avg` shadow model needs it.
- The collector logs `collector_meta.open_price_source`.

## Effect on trading
This changes the GBM inputs (prices and volatility) for markets opened on the composite feed, and makes many more markets eligible. The bot is in paper mode, and v3.4 found no edge in GBM, so expect more paper trades, not better ones. `USD_REFERENCE_ENABLED=false` restores Binance-only behaviour.
