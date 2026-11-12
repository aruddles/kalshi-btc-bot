'use strict';
// Read-only: npm run exit-vs-hold
const E = require('../lib/exit-hold-log');
const s = E.summarize(E.load());
const $ = x => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
console.log(`EXIT vs HOLD (pre-registered) — ${s.exits} take-profit exits / ${s.markets} markets (need ${s.minExits})`);
if (s.exits) {
  console.log(`Sold early: ${$(s.earlyExitPnl)} | If held: ${$(s.holdPnl)} | Early minus hold: ${$(s.totalDelta)} (${$(s.meanDelta)}/exit)`);
  console.log(`Exits that would have lost if held: ${s.wouldHaveLost}`);
}
if (s.ci95) console.log(`Mean delta 95% CI (market-clustered): [${$(s.ci95.low)}, ${$(s.ci95.high)}]`);
console.log(`STATUS: ${s.status}`);
