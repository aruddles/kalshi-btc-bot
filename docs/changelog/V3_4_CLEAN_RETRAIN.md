# v3.4 — Retrain on clean data (Observed, 2026-11-11)

`npm run historical:retrain` (`scripts/retrain-historical.js`; helpers in `lib/historical-eval.js`). The rules were fixed in the script header before the first run. Data: `historical-ml-v4-5000-markets.jsonl` (leak-free).

Markets are ordered by their first snapshot:
- Train: first 2,494 markets.
- Calibration: next 499.
- Test: last 1,996. The test set was used once, and it is the same test set as `historical:score`.

## Candidates
| Model | What it tests |
|---|---|
| STUMPS (per regime) | BAYMAX architecture refitted on clean data |
| KALSHI_RECAL | Is Kalshi's own price miscalibrated? |
| BLEND | Does GBM add information beyond Kalshi's price? |

## Accuracy: Brier minus KALSHI_MID on test (market-clustered 95% CI)
| Model | ALL | EARLY | LATE | FINAL |
|---|---|---|---|---|
| GBM, shrunk vol | +0.0045 [0.0027, 0.0066] | +0.0056 | +0.0036 | +0.0042 |
| KALSHI_RECAL | +0.0002 [−0.0001, 0.0004] | −0.0002 (ns) | +0.0004 | +0.0003 |
| BLEND | +0.0002 [−0.0000, 0.0005] | −0.0001 (ns) | +0.0005 | +0.0004 |
| STUMPS | +0.0178 [0.0159, 0.0200] | +0.0165 | +0.0227 | +0.0154 |

Fitted weights:
- BLEND: logit_mid 1.02, logit_gbm **0.04**.
- KALSHI_RECAL: slope 1.06.

Kalshi's price is close to perfectly calibrated, and GBM adds almost nothing once Kalshi's price is known.

## Trading: taker, 1 contract per test market, after fees (upper bound: no depth, no latency)
| Model | Min EV | Trades | Model-expected EV | Realized P&L / contract [95% CI] |
|---|---|---|---|---|
| GBM, shrunk vol | 0¢ | 1,995 | +6.3¢ | +0.07¢ [−2.09, 2.07] |
| GBM, shrunk vol | 5¢ | 1,800 | +9.7¢ | +0.10¢ [−1.79, 2.09] |
| STUMPS | 0¢ | 1,996 | +10.0¢ | +0.24¢ [−1.75, 2.19] |
| STUMPS | 5¢ | 1,995 | +12.5¢ | −0.75¢ [−2.74, 1.16] |
| BLEND | 0¢ | 1,657 | +0.3¢ | −0.75¢ [−2.30, 0.68] |

In the FINAL regime, every model that trades loses money, and the CIs are below zero for GBM, STUMPS, BLEND and KALSHI_RECAL.

## Result
**No candidate passes either rule.** The models expect 6–12¢ of edge per contract and realize about 0¢. That gap is model overconfidence, and it is what the live directional strategy would experience. Retrained models are saved in `data/models/retrained-v4/` for reference only. Do not promote them.

On 1-minute historical data, Kalshi's price already contains everything these features know. Any remaining edge has to come from information or speed the features don't capture: second-level quote staleness, final-minute settlement mechanics, or BRTI basis. That requires the Phase 2 capture data and the v3.3 BRTI shadow evaluation.
