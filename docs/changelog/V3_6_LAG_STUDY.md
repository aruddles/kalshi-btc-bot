# v3.6 — Kalshi vs BTC lead-lag study

Tests roadmap hypothesis #1: after a sharp BTC move, does Kalshi's KXBTC15M order book stay stale long enough for a taker to profit?

## Capture
`npm run capture:markets` (`scripts/capture-kalshi-history.js`) is data-only. It now also records:
- `usd_reference_quote`: every Coinbase, Kraken and Bitstamp top-of-book update. This is the composite BTC/USD (BRTI proxy) at venue resolution. `CAPTURE_USD_REFERENCE=false` disables it.
- `derived_quote` rows are now written only when the top of book changes, and keep `CAPTURE_QUOTE_DEPTH` levels per side (default 5).

**Fix:** each `derived_quote` row used to carry the full book (~560 levels, ~19KB) and was written on every delta (~460/s). That filled the 128MB budget in 15 seconds. Full depth is still recoverable from the raw `kalshi_ws` deltas.

**Size:** a 20-minute run was 487MB (~1.4GB/hour), mostly raw deltas. For long runs, raise `CAPTURE_MAX_BYTES` or use the Railway worker.

## Analysis
`npm run lag:study -- [capture.jsonl ...]` (`lib/lag-study.js`) is read-only. Its rules were fixed before any data:
- **Jump:** the composite moves ≥ $20 within 2s, at least 60s before the front market closes, with a 10s cooldown between jumps.
- **Response time:** time until Kalshi's YES mid moves ≥ 1¢ in the jump direction, measured from the mid just before the move.
- **Markout:** buy 1 contract of the jump side at the executable ask seen 0, 0.5, 1 and 2s after the jump. Value it at the mid 30s later, and at settlement, minus the taker fee. A latency passes only if the 95% CI of the mean is entirely above 0.
- **Cross-correlation:** of 1-second BTC changes and Kalshi mid changes at lags of −5…+10s.

Times are local receive times. They measure what this machine sees, including its network latency to each venue.

## First run (Observed, 2026-11-11 15:33–15:53 MST; 20 minutes, 2 markets, 13 jumps)
| Measure | Result |
|---|---|
| Kalshi YES mid had already moved ≥1¢ by the time the $20 jump completed | 54% of jumps |
| Moved within 1s / 5s of the jump | 69% / 69% (4 jumps: no 1¢ move within 15s) |
| Median response time | **−1.5s** (Kalshi moved during the BTC move, before our feed crossed $20) |
| Cross-correlation of 1s changes | peak at **0s** (0.44); −1s 0.17 > +1s 0.12 |
| Buy jump side at ask, 30s markout, after fees | 0ms: +0.22¢ [−3.83, 3.86]; 1s: −0.40¢ [−4.05, 2.83]; nothing passes |

**Reading:** at this machine's latency, Kalshi's book is not stale after BTC moves. It reprices in the same second, and often leads our composite feed. Market makers likely use faster or direct exchange feeds. The dashboard appearing "ahead of Kalshi" reflects Kalshi's website chart (BRTI, once per second), not its order book.

The sample is tiny (13 events), so this is a first look, not a verdict. Re-run on hours of capture before closing the hypothesis.
