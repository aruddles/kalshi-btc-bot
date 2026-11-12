#!/usr/bin/env node
'use strict';
// Scores every probability model against a historical dataset (read-only).
//
//   npm run historical:score -- --data data/historical-ml-v4-5000-markets.jsonl
//
// Models: Kalshi YES midpoint, GBM with the raw vol feature, GBM with the v3.2
// shrunk vol, and every saved BAYMAX / FINAL challenger snapshot (each on its own
// regime). Scored on the chronologically last 40% of markets, with a market-
// clustered bootstrap 95% CI for each model's Brier minus Kalshi's.
// Rows from historical-builder-v1 carry ~60s of future BTC price; the script
// refuses them unless --allow-leaky is passed.

const fs = require('fs');
const path = require('path');
const pipeline = require('../lib/ml-pipeline');
const H = require('../lib/historical-eval');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def; }

const DATA = arg('data', 'data/historical-ml-v4-5000-markets.jsonl');
const OUT = arg('out', 'data/historical-score/summary.json');
const TEST_FRACTION = Number(arg('test-fraction', 0.4));
const BOOTSTRAP = Number(arg('bootstrap', 500));
// Score only markets absent from this dataset (e.g. the one the saved models were trained on).
const UNSEEN_VS = arg('unseen-vs', null);
const SNAPSHOTS = {
  BAYMAX_FINAL_5K: { file: 'data/models/baymax-final-5k.json', regime: 'FINAL' },
  FINAL_CHALLENGER_1K: { file: 'data/final-challenger-1k-model.json', regime: 'FINAL' },
  BAYMAX_LATE_5K: { file: 'data/models/baymax-late-5k.json', regime: 'LATE' },
  BAYMAX_EARLY_5K: { file: 'data/models/baymax-early-5k.json', regime: 'EARLY' },
};
const { kalshiMid, gbm, metrics, bootstrapDelta, clip } = H;

function snapshotModel(file) {
  if (!fs.existsSync(file)) return null;
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  return r => clip(pipeline._applyCalibration(pipeline._predictStumpModel(snap.model, H.projectMarketOnly(r.features)), snap.calibration));
}

function main() {
  const rows = H.loadRows(DATA, { allowLeaky: Boolean(arg('allow-leaky', false)) }).filter(r => kalshiMid(r) != null);
  const tickers = [...new Set(rows.map(r => r.ticker))];
  let testTickers = new Set(tickers.slice(Math.floor(tickers.length * (1 - TEST_FRACTION))));
  if (UNSEEN_VS) {
    const seen = new Set(fs.readFileSync(UNSEEN_VS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).ticker));
    testTickers = new Set([...testTickers].filter(t => !seen.has(t)));
    if (!testTickers.size) throw new Error(`no test markets are absent from ${UNSEEN_VS}`);
  }
  const train = rows.filter(r => !testTickers.has(r.ticker)), test = rows.filter(r => testTickers.has(r.ticker));

  // Long-run vol level for the shrunk GBM comes from the training markets only.
  const medianVol = H.medianVolPerMinute(train);
  const rawVol = r => (r.features[5] > 0 ? r.features[5] / 1000 : medianVol);

  const models = {
    KALSHI_MID: () => kalshiMid,
    GBM_RAW_VOL: () => r => gbm(r, rawVol(r)),
    GBM_SHRUNK_VOL: () => r => H.gbmShrunk(r, medianVol),
  };
  for (const [name, { file }] of Object.entries(SNAPSHOTS)) { const m = snapshotModel(file); if (m) models[name] = () => m; }

  const scopes = { ALL: test };
  for (const regime of ['FINAL', 'LATE', 'EARLY']) scopes[regime] = test.filter(r => r.specialist_regime === regime);

  const results = {};
  for (const [scope, set] of Object.entries(scopes)) {
    if (!set.length) continue;
    const kalshi = set.map(kalshiMid);
    results[scope] = {};
    for (const [name, make] of Object.entries(models)) {
      const regime = SNAPSHOTS[name]?.regime;
      if (regime && scope !== regime) continue;
      const f = make(), probs = set.map(r => f(r));
      results[scope][name] = { ...metrics(set, probs), vsKalshiBrier: name === 'KALSHI_MID' ? null : bootstrapDelta(set, probs, kalshi, BOOTSTRAP) };
    }
  }

  const summary = {
    data: path.basename(DATA), unseenVs: UNSEEN_VS ? path.basename(UNSEEN_VS) : null, builder: [...new Set(rows.map(r => r.collector_version))],
    markets: tickers.length, trainMarkets: tickers.length - testTickers.size, testMarkets: testTickers.size,
    dateRange: { first: rows[0]?.ts, last: rows[rows.length - 1]?.ts }, medianVolPerMinute: medianVol,
    note: 'Saved snapshots were fitted on earlier (leaky) data that may include these markets; their scores here are optimistic.',
    results, runTimestamp: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));

  console.log(`HISTORICAL MODEL SCORECARD — ${summary.data} (${summary.builder.join(', ')})`);
  console.log(`Markets: ${summary.markets} | scored on ${summary.testMarkets} test markets (chronologically last ${Math.round(TEST_FRACTION * 100)}%${UNSEEN_VS ? `, excluding any in ${summary.unseenVs}` : ''}) | ${summary.dateRange.first} -> ${summary.dateRange.last}`);
  for (const [scope, res] of Object.entries(results)) {
    console.log(`\n${scope}`);
    console.log('MODEL                  OBS     BRIER    LOGLOSS  ACC     BRIER vs KALSHI [95% CI]');
    for (const [name, m] of Object.entries(res)) {
      const d = m.vsKalshiBrier;
      const vs = d ? `${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(4)} [${d.lo.toFixed(4)}, ${d.hi.toFixed(4)}]${d.hi < 0 ? ' BETTER' : d.lo > 0 ? ' WORSE' : ''}` : '--';
      console.log(`${name.padEnd(22)} ${String(m.observations).padStart(6)}  ${m.brier.toFixed(4)}   ${m.logLoss.toFixed(4)}   ${(m.accuracy * 100).toFixed(1)}%   ${vs}`);
    }
  }
  console.log(`\nSummary: ${OUT}`);
}

try { main(); } catch (e) { console.error(`[HistoricalScore] ${e.message}`); process.exitCode = 1; }
