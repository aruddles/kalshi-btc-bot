# v2.7.1 Historical Reliability

## Purpose
This patch improves Historical Dataset Builder v1 fetch reliability and diagnostics without changing production trading, ML PAPER, settlement labels, or production model training.

## Retry policy
Historical Kalshi and Coinbase HTTP clients retry only transient failures: HTTP 408, 429, 500, 502, 503, 504, timeouts (`ECONNABORTED`/`ETIMEDOUT`), connection resets, and selected temporary network failures. The default is 4 total attempts with bounded exponential backoff beginning near 500 ms. `Retry-After` seconds and HTTP-date forms are respected and capped. Permanent failures such as 404 are not repeatedly retried.

Use `--max-attempts N` to change the total attempt bound. Retries are historical-builder-only; production execution clients are unchanged.

## Request pacing
Markets are processed sequentially. By default the CLI waits 250 ms between the Kalshi and Coinbase historical requests and after a completed market. Configure with `--request-delay-ms N`. Reliability is prioritized over throughput.

## Diagnostics
The quality report separates Kalshi and Coinbase failure categories (`429`, `404`, `5xx`, `timeout`, `network`, or another HTTP status) and reports requests attempted, retries attempted, recoveries after retry, permanent failures, and markets recovered through retry. Permanent market failures include only ticker, provider, category, status/code, and stage; request headers, signatures, and credentials are never copied into the report.

No missing candle, probability, BTC value, feature, or order-book depth is fabricated. Historical depth remains unavailable and explicitly false.

## Checkpoint / resume
The default checkpoint is `data/.historical-ml-checkpoint.json`. It is local runtime state, not training data. After a market reconstructs successfully, its ticker is atomically added by temp-file + rename. `--resume` skips those successful tickers. Failed tickers are not marked complete and may be retried later. Corrupted checkpoint JSON is ignored with a warning. Observation IDs remain deterministic because they are still derived only from ticker + minute timestamp.

Checkpoint state does not contain reconstructed observations and is excluded from release packaging.

## Historical-compatible market-only features
The authoritative names/indexes are derived from the production 27-feature mapping, not duplicated guesses.

Included market-only features:

- 0 `spot_move`
- 1 `abs_move`
- 2 `move_dir`
- 3 `time_remaining`
- 4 `time_elapsed`
- 5 `volatility`
- 6 `high_vol`
- 9 `price`
- 11 `yes_spread`
- 12 `no_spread`
- 13 `combined_ask`
- 14 `dual_margin`
- 21 `trend_strength`
- 22 `trend_roc`

Excluded/unavailable for a market-only historical experiment: `edge`, `model_prob`, `contracts`, `is_directional`, `is_poly_arb`, `is_dual_side`, `is_buy_yes`, `trend_aligned`, `trend_counter`, `recent_wr`, `recent_pnl`, `streak`, and `balance`.

The full schema, compatible indexes/names, and unavailable list are exported by `lib/historical-dataset-builder.js` and included in quality reports.

## Production isolation
Historical observations remain `source=historical`, `quality_grade=B`, one-minute resolution, and are written only to `ml_historical_staging` when `--write` is explicitly requested. They are not admitted to `ml_features`. GLOBAL/EARLY/LATE/FINAL production training still uses the existing Grade-A 27-feature pipeline. This release does not run the proposed Grade-A vs Grade-A+Grade-B experiment.

## Commands
25-market dry run:

```bash
npm run historical:ml -- --limit 25
```

250-market dry run:

```bash
npm run historical:ml -- --limit 250
```

Resume a prior run:

```bash
npm run historical:ml -- --limit 250 --resume
```

Custom reliability settings:

```bash
npm run historical:ml -- --limit 250 --resume --max-attempts 4 --request-delay-ms 250
```

Use `--checkpoint <path>` to override the checkpoint location. Ordinary dry runs still do not write Supabase production training data; they do write the requested local dry-run JSONL plus checkpoint runtime state.

## Known limitations
Kalshi historical order-book depth is unavailable and remains unmodeled. One-minute candles cannot reproduce five-second Grade-A microstructure. A market that genuinely lacks required point-in-time Kalshi/BTC data is skipped rather than filled. Resume checkpoints track completed tickers but intentionally do not duplicate reconstructed rows inside the checkpoint; users should treat staging/output files separately from runtime checkpoint state.
