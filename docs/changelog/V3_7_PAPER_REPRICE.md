# v3.7 — Paper orders reprice like live (fix for paper no-fills)

## Problem (Observed in paper logs, 2026-11-11)
Paper IOC orders repeatedly returned no fill, which triggered a 15-second no-fill cooldown and a `Blocked … (no_fill_cooldown)` warning on every scan.

The cause was a paper/live mismatch:
- **Live:** just before sending, the executor re-reads the order book, reprices to the current ask, and re-checks the fee-adjusted edge.
- **Paper:** it skipped that step and sent the signal's price, which is 2–5 seconds old because quotes are cached for 3s and the scan runs every 2s. The PaperBroker correctly refused to fill whenever the fresh ask had moved above that limit.

The v3.6 lag study shows Kalshi reprices within the same second as BTC, so this happened often. Paper results were therefore not comparable to live.

## Fix
- Paper mode now reprices from the same fresh market quote the PaperBroker fills against. It applies the same execution edge floor and budget checks as live (`MIN_EDGE`, default 10%). PAPER+ uses `PAPER_PLUS_MIN_EDGE` (default 3%).
- The no-fill cooldown is logged once when it starts, not on every scan.

## Effect
- Paper no longer records stale-price no-fills. Expect **fewer paper trades**: signals whose fresh fee-adjusted edge is below `MIN_EDGE` are now skipped as `fresh_edge_below_min`, exactly as live would skip them.
- Example: the 9.6% fresh-edge trade in the original log would now be skipped.
- Remaining paper no-fills are genuine: the ask moved between the reprice and the fill check, or there was no size at the touch.
