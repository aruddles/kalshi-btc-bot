# Kalshi fixed-point migration and safety changes

## What changed in the Kalshi API (and how the bot now handles it)

Verified against Kalshi's published docs/SDK models on 2026-11-01.

| Area | Old (what the bot assumed) | Now |
|---|---|---|
| Market prices | `yes_bid`, `yes_ask`, `no_bid`, `no_ask`, `last_price` (integer cents) | `*_dollars` strings, e.g. `"0.5200"`. The cent fields no longer exist on the market object. |
| Market depth | not used | `yes_bid_size_fp`, `yes_ask_size_fp` (strings). NO-side depth is the opposite YES side. |
| Orders (create) | `POST /portfolio/orders`, `action`, `side`, `count`, `yes_price` cents | `POST /portfolio/events/orders`: `side` = `bid`/`ask` on the **YES leg**, `count` and `price` as strings, required `time_in_force` and `self_trade_prevention_type`. Flat response (`fill_count`, `remaining_count`, `average_fill_price`, `average_fee_paid`). |
| Orders (read) | `fill_count`, `taker_fill_cost`, `taker_fees` (ints, cents) | `fill_count_fp`, `taker_fill_cost_dollars`, `taker_fees_dollars`, ... (strings) |
| Balance | `balance` cents + `payout` | `balance` cents + `balance_dollars`; no `payout` field |
| Positions | `yes_sub_total` / `no_sub_total` | `position_fp` (negative = NO), `market_exposure_dollars` |

All parsing lives in `lib/kalshi-format.js`. The rest of the bot still sees dollar numbers, `*Cents`
display fields, and order cost/fees in cents, so strategy/accounting code did not need rewriting.
Legacy cent fields are accepted as a fallback only; they never produce NaN.

Buying NO at `q` is sent as an **ask on the YES leg at `1 - q`**; selling NO is a YES **bid** at `1 - q`.
Entries are immediate-or-cancel at the observed ask; exits are IOC + reduce-only.

## Unverified (could not be confirmed without a live account) — check before going live

1. The legacy `POST /portfolio/orders` deprecation date has passed; V2 is the default and `KALSHI_ORDER_API=legacy` is an unverified fallback.
2. Whether KXBTC15M has a non-standard fee multiplier. The bot assumes 1; in live mode it compares the exchange's
   `average_fee_paid` to its model and **halts after two mismatches**.
3. The cancel-order path (only used for non-IOC orders, which the bot no longer sends).
4. `external-api.kalshi.com` is now the default base URL (per Kalshi's docs). Override with `KALSHI_API_BASE`.

## Bugs fixed

- **Lost positions:** an order that filled immediately at placement was never promoted to a tracked position.
- **Reconciled positions were dumped:** imported positions had entry price 0, so take-profit saw an infinite gain.
- Reconcile used removed `yes_sub_total` fields, and a failed positions call was read as "flat" (wiping local positions).
- Entry cost ignored fees; take-profit ignored entry and exit fees; partial exits closed the whole position.
- Balance was debited for unfilled IOC orders; zero-fill orders were scheduled for settlement.
- Legacy strategy forced a 1-contract minimum when sizing said 0; its Polymarket path skipped fee multiplier and fee-aware sizing.
- A failed market refresh silently kept trading on stale quotes.
- Position settlement timers did not survive restarts.
- Supabase `INTEGER` columns rejected fractional-cent fees.
- `server.js`: unauthenticated start/stop reachable cross-origin (CSRF) on all interfaces; `/api/ml` sent two responses.

## New safety layer

- `TRADING_MODE=paper` by default; the switch to real orders is one explicit setting, enforced inside the Kalshi client.
- Paper broker fills only against displayed depth, charges fees plus a latency penalty, settles against real outcomes.
- Risk rules from Rules.md are now code: loss tiers, 5-failure halt, balance floor, stale-price block, exposure cap, fee drift.
- Kill switch: `./data/KILL` file, `TRADING_ENABLED=false`, or `POST /api/halt`. Exits stay allowed under soft halts; a 401 is a hard halt.
- `kalshi-bot.js` (pre-agent monolith) is retired; original preserved inert in `legacy/`.

## Limits that remain

- Paper results are an **upper bound**: no queue position, no depth beyond the touch, no cancellations.
- Paper cash resets on restart (rebuilt from persisted positions and realized P&L).
- The open price is still a Binance proxy, not Kalshi's settlement reference.
- Nothing here shows the strategy has an edge. Run paper for weeks and compare to the captured-data replay first.
