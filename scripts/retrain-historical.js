#!/usr/bin/env node
'use strict';
// Retrain candidate models on the clean historical dataset and test them once
// against Kalshi on later, untouched markets.
//
//   npm run historical:retrain -- --data data/historical-ml-v4-5000-markets.jsonl
//
// Rules, fixed before the first run (2026-11-11). Do not tune against the test output.
//   Split: markets ordered by first snapshot; first 50% train, next 10% calibration,
//          last 40% test (the same test markets as historical:score).
//   Candidates (all fitted on train/calibration only):
//     STUMPS_<REGIME>  BAYMAX architecture (MLPipeline boosted stumps, 14 market-only
//                      features) refitted per regime, logistic-calibrated on calibration.
//     KALSHI_RECAL     logistic on [1, logit(mid), logit(mid)*tau]; tests whether Kalshi's
//                      price is itself miscalibrated (tau = time remaining / 900s).
//     BLEND            logistic on [1, logit(mid), logit(gbm), logit(mid)*tau, logit(gbm)*tau];
//                      tests whether GBM adds information beyond Kalshi's price.
//   Pass (accuracy): Brier minus KALSHI_MID on test, market-clustered 95% CI entirely < 0.
//   Pass (tradable): simulated taker P&L per contract after fees, one trade per market,
//                    95% CI entirely > 0, at a pre-declared min-EV threshold (0, 2c or 5c).
//   Both must pass before a model is worth forward paper testing. Neither is proof of live edge.

const fs = require('fs');
const path = require('path');
const pipeline = require('../lib/ml-pipeline');
const H = require('../lib/historical-eval');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def; }
const DATA = arg('data', 'data/historical-ml-v4-5000-markets.jsonl');
const OUT = arg('out', 'data/historical-retrain/summary.json');
const MODEL_DIR = arg('model-dir', 'data/models/retrained-v4');
const REGIMES = ['EARLY', 'LATE', 'FINAL'];
const MIN_EV = [0, 0.02, 0.05];

function main() {
  const rows = H.loadRows(DATA).filter(r => H.kalshiMid(r) != null);
  const split = H.chronologicalSplit(rows, [0.5, 0.1, 0.4]);
  const { train, calibration, test } = split;
  const fitRows = [...train, ...calibration];
  const medianVol = H.medianVolPerMinute(train);
  const tau = r => r.metadata.time_remaining_s / 900;
  const Lk = r => H.logit(H.kalshiMid(r)), Lg = r => H.logit(H.gbmShrunk(r, medianVol));

  // --- fit (train + calibration only) ---
  const stumps = {};
  for (const regime of REGIMES) {
    const tr = train.filter(r => r.specialist_regime === regime).map(r => ({ ...r, features: H.projectMarketOnly(r.features) }));
    const ca = calibration.filter(r => r.specialist_regime === regime).map(r => ({ ...r, features: H.projectMarketOnly(r.features) }));
    const model = pipeline._fitStumpModel(tr);
    const calib = pipeline._fitCalibration(ca, r => pipeline._predictStumpModel(model, r.features));
    stumps[regime] = { model, calibration: calib || null, trainObservations: tr.length, calibrationObservations: ca.length };
  }
  const designRecal = r => [1, Lk(r), Lk(r) * tau(r)];
  const designBlend = r => [1, Lk(r), Lg(r), Lk(r) * tau(r), Lg(r) * tau(r)];
  const wRecal = H.fitLogistic(fitRows.map(designRecal), fitRows.map(r => r.label));
  const wBlend = H.fitLogistic(fitRows.map(designBlend), fitRows.map(r => r.label));

  const predictors = {
    KALSHI_MID: r => H.kalshiMid(r),
    GBM_SHRUNK_VOL: r => H.gbmShrunk(r, medianVol),
    KALSHI_RECAL: r => H.predictLogistic(wRecal, designRecal(r)),
    BLEND: r => H.predictLogistic(wBlend, designBlend(r)),
    STUMPS: r => {
      const s = stumps[r.specialist_regime];
      return pipeline._applyCalibration(pipeline._predictStumpModel(s.model, H.projectMarketOnly(r.features)), s.calibration);
    },
  };

  // --- test once ---
  const scopes = { ALL: test, ...Object.fromEntries(REGIMES.map(g => [g, test.filter(r => r.specialist_regime === g)])) };
  const results = {};
  for (const [scope, set] of Object.entries(scopes)) {
    const kalshi = set.map(H.kalshiMid);
    results[scope] = {};
    for (const [name, f] of Object.entries(predictors)) {
      const probs = set.map(f);
      results[scope][name] = {
        ...H.metrics(set, probs),
        vsKalshiBrier: name === 'KALSHI_MID' ? null : H.bootstrapDelta(set, probs, kalshi),
        trading: MIN_EV.map(minEv => H.simulateTrades(set, probs, { minEv })),
      };
    }
  }

  fs.mkdirSync(MODEL_DIR, { recursive: true });
  for (const regime of REGIMES) fs.writeFileSync(path.join(MODEL_DIR, `stumps-${regime.toLowerCase()}.json`), JSON.stringify({ modelIdentity: `STUMPS_${regime}_V4`, regime, data: path.basename(DATA), ...stumps[regime], createdAt: new Date().toISOString() }));
  const summary = {
    data: path.basename(DATA), split: { trainMarkets: split.tickers[0].size, calibrationMarkets: split.tickers[1].size, testMarkets: split.tickers[2].size },
    medianVolPerMinute: medianVol,
    coefficients: { KALSHI_RECAL: { names: ['intercept', 'logit_mid', 'logit_mid*tau'], w: wRecal }, BLEND: { names: ['intercept', 'logit_mid', 'logit_gbm', 'logit_mid*tau', 'logit_gbm*tau'], w: wBlend } },
    results, runTimestamp: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));

  // --- report ---
  const ci = d => `${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(4)} [${d.lo.toFixed(4)}, ${d.hi.toFixed(4)}]${d.hi < 0 ? ' BETTER' : d.lo > 0 ? ' WORSE' : ''}`;
  console.log(`RETRAIN ON CLEAN DATA — ${summary.data}`);
  console.log(`Train ${summary.split.trainMarkets} | calibration ${summary.split.calibrationMarkets} | untouched test ${summary.split.testMarkets} markets`);
  console.log(`BLEND weights: ${summary.coefficients.BLEND.names.map((n, i) => `${n}=${wBlend[i].toFixed(3)}`).join('  ')}`);
  console.log(`KALSHI_RECAL weights: ${summary.coefficients.KALSHI_RECAL.names.map((n, i) => `${n}=${wRecal[i].toFixed(3)}`).join('  ')}`);
  for (const [scope, res] of Object.entries(results)) {
    console.log(`\n${scope}`);
    console.log('MODEL            BRIER    LOGLOSS  BRIER vs KALSHI [95% CI]          TRADES@0c  P&L/contract [95% CI]');
    for (const [name, m] of Object.entries(res)) {
      const t = m.trading[0], p = t.pnlPerContract;
      const tr = p ? `${String(t.trades).padStart(5)}      ${(p.mean * 100).toFixed(2)}c [${(p.lo * 100).toFixed(2)}, ${(p.hi * 100).toFixed(2)}]` : `${String(t.trades).padStart(5)}      --`;
      console.log(`${name.padEnd(16)} ${m.brier.toFixed(4)}   ${m.logLoss.toFixed(4)}   ${(m.vsKalshiBrier ? ci(m.vsKalshiBrier) : '--').padEnd(33)} ${tr}`);
    }
  }
  console.log('\nTRADING (ALL test markets, 1 contract per market, after taker fees)');
  console.log('MODEL            MIN EV  TRADES  WIN%    EXPECTED  REALIZED P&L/contract [95% CI]');
  for (const [name, m] of Object.entries(results.ALL)) {
    for (const t of m.trading) {
      const p = t.pnlPerContract;
      console.log(`${name.padEnd(16)} ${(t.minEv * 100).toFixed(0).padStart(4)}c  ${String(t.trades).padStart(6)}  ${t.winRate == null ? '  -- ' : (t.winRate * 100).toFixed(1).padStart(5)}%  ${t.avgExpectedEv == null ? '   --  ' : ((t.avgExpectedEv * 100).toFixed(2) + 'c').padStart(7)}   ${p ? `${(p.mean * 100).toFixed(2)}c [${(p.lo * 100).toFixed(2)}, ${(p.hi * 100).toFixed(2)}]${p.lo > 0 ? ' PROFITABLE' : p.hi < 0 ? ' LOSING' : ''}` : '--'}`);
    }
  }
  console.log(`\nSummary: ${OUT}\nModels: ${MODEL_DIR}/`);
}

try { main(); } catch (e) { console.error(`[HistoricalRetrain] ${e.message}`); process.exitCode = 1; }
