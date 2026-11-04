# ML Training v1

This patch preserves the existing live order execution path and changes only ML observation/label lifecycle.

## Behavior
- Feature rows are written only after a Kalshi order has a confirmed fill.
- `observation_id` is stable and deterministic: `kalshi-order:<order_id>`.
- Supabase uses an upsert on `observation_id`, so retries do not duplicate the observation.
- `label` is NULL while the market is unresolved.
- At actual Kalshi settlement, label = 1 if the original predicted side equals `market.result`; otherwise label = 0.
- Take-profit P&L never determines the ML label.
- If a full take-profit closes the financial position early, its closed-position metadata is retained and the settlement timer later labels the original prediction from Kalshi's actual result.

## Required Supabase migration
Run the appended `ML training v1` statements at the bottom of `lib/supabase-migrations.sql` in the Supabase SQL Editor before relying on ML writes.
