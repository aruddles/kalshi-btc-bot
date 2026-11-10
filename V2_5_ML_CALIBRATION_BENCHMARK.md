# v2.5 ML Calibration + Kalshi Benchmark

## Purpose
v2.5 evaluates whether the existing canonical `MARKET_SNAPSHOT_YES` model adds information beyond Kalshi. ML remains **shadow-only**: its output is telemetry and evaluation only and cannot block, resize, create, or alter an order.

## Chronological split
Labeled canonical snapshots are grouped by ticker, each ticker is ordered by its earliest observation timestamp, and whole markets are split approximately 70% TRAIN / 15% CALIBRATION / 15% TEST. A ticker can appear in only one set. Normalization and stump fitting use TRAIN only; Platt calibration uses CALIBRATION only; TEST is untouched until evaluation.

## Calibration
The raw model probability is retained. A one-dimensional Platt/logistic transform is fitted on calibration snapshots only: `sigmoid(a * logit(raw_probability) + b)`. Parameters and calibration sample/market counts are exposed in ML status. If the calibration set lacks both classes, calibration is unavailable and trading continues safely without ML influence.

## Kalshi benchmark
Canonical snapshot feature index 9 is the historical YES ask/contract probability captured at that observation timestamp. Only finite values strictly between 0 and 1 are benchmark-eligible. Missing/invalid values are excluded and counted; no historical price is fabricated. RAW ML, CAL ML, and Kalshi comparison metrics use the identical benchmark-eligible TEST observations.

## Metrics
Brier score is mean squared probability error; lower is better. Log loss is cross-entropy with probabilities clipped away from 0/1 for numerical safety. Snapshot accuracy uses a 0.5 threshold. Market accuracy uses the final eligible snapshot for each ticker, a leakage-safe rule based only on information available before settlement. YES and NO market accuracies are also reported.

## Calibration, edge, and time buckets
TEST calibration buckets span 0–10% through 90–100%, reporting observations, markets, mean prediction, observed YES rate, and low-sample flags. Actionable edge is `calibrated_probability - Kalshi YES probability`; absolute disagreement buckets cover both YES and NO opportunities. Historical P&L/ROI is intentionally unavailable because canonical snapshot rows do not contain reliable executable fills/fees. Time buckets are 10–15m, 5–10m, 2–5m, 30s–2m, and <30s.

## Feature names
The authoritative 27-element feature mapping lives next to `extractFeatures()` in `lib/ml-pipeline.js`. Importance output uses those names; unknown indexes fall back to `fN` rather than being guessed.

## Limitations
Snapshots within a market are correlated, so market-level results matter more than raw snapshot counts. The current model is lightweight boosted decision stumps. Kalshi benchmarking uses the stored YES ask field, not guaranteed historical fills. Canonical snapshots do not safely support fee-inclusive counterfactual P&L. Small TEST/calibration buckets can be noisy and are marked rather than hidden.

## Safety
Calibration/evaluation errors never invoke execution. The ML scorer passes original strategy signals through unchanged in v2.5 while attaching shadow diagnostics. LIVE order submission, confirmation, risk, take-profit, and broker execution code are not modified by this release.
