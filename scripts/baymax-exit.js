#!/usr/bin/env node
// BAYMAX_EXIT_V1 (pre-registered; rules in lib/baymax-exit.js + research ledger). Read-only.
//   npm run baymax-exit              -> counts only until >= 600 eligible exits, then the one-time verdict
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');
const E = require('../lib/exit-hold-log');
const B = require('../lib/baymax-exit');

(async () => {
  try {
    supabase.initialize();
    if (!supabase.enabled) throw new Error('Supabase not configured (run on the bot machine with .env)');
    const exits = E.load();
    const tickers = [...new Set(exits.map(e => e.ticker).filter(Boolean))];
    const snaps = new Map();
    for (const t of tickers) snaps.set(t, await supabase.getCollectorSnapshots(t));
    const res = B.evaluate(B.buildRows(exits, snaps));
    const c = res.coverage;
    console.log('BAYMAX_EXIT_V1 — hold vs sell (pre-registered)');
    console.log(`Exits logged: ${c.totalExits} | eligible: ${c.eligible}/${c.needed} | excluded: no snapshot ${c.excluded.noSnapshot}, missing feature ${c.excluded.missingFeature}, bad row ${c.excluded.badRow}`);
    if (res.status === 'INSUFFICIENT_DATA') {
      console.log('STATUS: INSUFFICIENT_DATA — counts only; outcomes stay unseen until the threshold.');
    } else {
      const $ = x => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
      console.log(`Train ${res.split.train} (to ${res.split.trainEnds}) | Test ${res.split.test} (from ${res.split.testStarts})`);
      console.log('ARM               TEST P&L   HOLDS');
      for (const [k, v] of Object.entries(res.arms)) console.log(`${k.padEnd(16)} ${$(v.pnl).padStart(9)}   ${v.holds}`);
      const f = x => `[${$(x.low)}, ${$(x.high)}]`;
      console.log(`Per-exit 95% CI  C-A ${f(res.ci.C_minus_A)} | D-A ${f(res.ci.D_minus_A)} | D-C ${f(res.ci.D_minus_C)}`);
      console.log(`Brier (test): Kalshi mid ${res.secondaryBrier.kalshiMid.toFixed(4)} | brti_p ${res.secondaryBrier.brtiP.toFixed(4)} | ML ${res.secondaryBrier.ml.toFixed(4)}`);
      console.log(`STATUS: ${res.status}`);
    }
    const out = 'data/baymax-exit/summary.json';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...res, runTimestamp: new Date().toISOString() }, null, 2));
  } catch (e) { console.error(`[BAYMAX-EXIT] ${e.message}`); process.exitCode = 1; }
})();
