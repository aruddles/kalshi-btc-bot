# v3.2 — Historical lookahead fix, volatility shrinkage, repo cleanup

## 1. Critical bug fix: lookahead in the historical dataset builder (Observed)
Coinbase candles are keyed by bucket **start**. `lib/historical-dataset-builder.js` picked the latest candle with `start <= t` and used its close, which is the price at `t + 60s`. Every historical row (`historical-builder-v1`) therefore carries roughly one minute of future BTC price in `btc_price`, `spot_move`, `abs_move`, `move_dir`, `volatility`, and the trend features.

Effect on the 5k-market set: plain GBM Brier went from 0.107 (leaky) to 0.143 when evaluated at the true horizon, and the leaky GBM appeared to beat the Kalshi mid (0.118). It does not.

**Consequences:** the BAYMAX, specialist, residual, model-arena, and final-precision results trained or evaluated on `historical-ml-v1/v3` and `baymax-oos-v1` data overstate skill. Treat them as invalid until the datasets are rebuilt with `npm run historical:ml` (rows are now tagged `historical-builder-v2`).

Fix: candles carry `closeMs = start + 60s`, and snapshots, realized vol, and trend use only candles with `closeMs <= t`. Regression test: `tests/volatility-v32.test.js`.

## 2. Volatility estimator (Observed offline, live effect unverified)
`lib/volatility.js` replaces `BinanceFeed.getRecentVolatility`:
- Time-normalised variance, `sum(r^2) / sum(dt)`, so feed gaps count at their real length.
- The trailing contract-length window is shrunk 50/50 (in variance) toward the full 1-hour history.

Offline evidence: 5k markets, leak-corrected horizon, rows with ≥2 minutes of true horizon, chronological 60/40 split. Log loss was 0.422 → 0.405 on train and 0.455 → 0.445 on test. Brier was 0.1432 → 0.1408 on test. The historical vol input is a noisy 5×1-minute estimate. Live 1-second data is less noisy, so expect a smaller live gain.

Tested and **not** adopted: the settlement-averaging variance (no gain at 1-minute resolution; it stays shadow-only) and flat vol multipliers (inconsistent across splits).

## 3. Cleanup
- Removed the retired `kalshi-bot.js` stub, `legacy/`, the unreferenced `bot/engine.js` and `bot/strategy.js` (with its one legacy test), and the unused langchain optional deps.
- Moved the per-version notes to `docs/changelog/`, and `troubleshooting.md` and the backtest findings to `docs/`.
- Deduplicated `.gitignore`. `npm run dev` now loads `.env` like `npm start`.

## 4. Clean re-score (Observed, 2026-11-11)
The dataset was rebuilt with the fixed builder as `data/historical-ml-v4-5000-markets.jsonl`: 4,989 markets, 54,879 rows, all `historical-builder-v2`, 0 fetch failures. Scored with `npm run historical:score` on the chronologically last 40% (1,996 markets). The figures below are the Brier score minus the Kalshi mid's Brier score, with a market-clustered 95% CI. Positive means worse than Kalshi.

| Model | ALL | FINAL | LATE | EARLY |
|---|---|---|---|---|
| GBM, raw vol | +0.0060 [0.0040, 0.0081] | +0.0061 | +0.0050 | +0.0068 |
| GBM, v3.2 shrunk vol | +0.0043 [0.0026, 0.0064] | +0.0040 | +0.0034 | +0.0053 |
| BAYMAX_FINAL_5K | | +0.0153 [0.0117, 0.0192] | | |
| FINAL_CHALLENGER_1K | | +0.0170 [0.0143, 0.0197] | | |
| BAYMAX_LATE_5K | | | +0.0261 [0.0214, 0.0308] | |
| BAYMAX_EARLY_5K | | | | +0.0185 [0.0149, 0.0216] |

On the 568 newest markets, which none of the saved models trained on (`--unseen-vs data/historical-ml-v3-5000-markets.jsonl`), the picture is the same. The BAYMAX models score +0.015 to +0.034 against Kalshi.

**Conclusions:**
- No model beats the Kalshi midpoint in any regime. The CIs exclude zero for every model on the full test set.
- The v3.2 vol shrinkage improves GBM consistently, but GBM remains worse than the market.
- The saved BAYMAX and FINAL challenger models are the worst performers. Their earlier apparent skill came from the lookahead leak. Do not promote them.
- The directional strategy trades only when GBM disagrees with Kalshi by more than the edge threshold. On this evidence those disagreements are model error, not edge. Keep it in paper mode.

Limits: these are 1-minute candles with no order-book depth, and the vol input is a 5×1-minute estimate. They cannot rule out a short-horizon (seconds) edge, which is what Phase 2 data capture is for.
