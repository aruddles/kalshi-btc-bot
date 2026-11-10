'use strict';
// Read-only: npm run settlement:shadow-eval -> data/settlement-shadow/summary.json
const fs = require('fs'), path = require('path');
const supabase = require('../lib/supabase');
const E = require('../lib/settlement-shadow-eval');
(async () => {
  try {
    supabase.initialize();
    if (!supabase.enabled) throw new Error('Supabase not configured');
    const r = E.evaluate(await supabase.getSettlementShadowRows());
    const outDir = 'data/settlement-shadow';
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ ...r, runTimestamp: new Date().toISOString() }, null, 2));
    const f = x => (x == null ? '   --  ' : x.toFixed(5));
    console.log(`SETTLEMENT SHADOW EVAL (v3.1) — ${r.markets} markets (need ${r.minMarkets})`);
    console.log('REGIME   MKTS   KALSHI_MID  GBM_POINT  SETTLEMENT   (Brier)');
    for (const [n, m] of [['ALL', r.all], ...Object.entries(r.regimes)]) {
      console.log(`${n.padEnd(7)} ${String(m.markets).padStart(5)}   ${f(m.KALSHI_MID?.brier)}    ${f(m.GBM_POINT?.brier)}    ${f(m.SETTLEMENT?.brier)}`);
    }
    const ci = r.all.brierDiff?.SETTLEMENT_minus_GBM;
    if (ci) console.log(`SETTLEMENT - GBM Brier 95% CI: [${ci.low.toFixed(5)}, ${ci.high.toFixed(5)}]`);
    if (r.strikeBasisUsd) console.log(`Strike basis (Binance pre-open avg - floor_strike): median $${r.strikeBasisUsd.median.toFixed(2)}, p05..p95 $${r.strikeBasisUsd.p05.toFixed(2)}..$${r.strikeBasisUsd.p95.toFixed(2)}`);
    console.log(`STATUS: ${r.status}`);
  } catch (e) { console.error(`[SETTLEMENT-SHADOW-EVAL] ${e.message}`); process.exitCode = 1; }
})();
