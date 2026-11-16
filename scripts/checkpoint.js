#!/usr/bin/env node
// Checkpoint report (read-only): npm run checkpoint
// Everything here reads local files under data/. Tests that need Supabase
// (baymax-exit, settlement shadow eval) are listed with the command to run on the host.
const fs = require('fs');
const path = require('path');
const C = require('../lib/checkpoint');

const dataDir = process.argv[2] || 'data';
const jsonl = f => { try { return fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const $ = x => (x == null ? '    --' : (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2));
const c = x => (x == null ? '--' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + 'c');
const pct = x => (x == null ? '--' : (x * 100).toFixed(1) + '%');
const out = {};

const trades = jsonl('trades.jsonl');
const main = out.mainBot = C.mainBotReport(trades, jsonl('latency.jsonl'));
console.log(`CHECKPOINT REPORT  ${new Date().toISOString()}`);
console.log(`\nMAIN BOT (logged trades; paper fills switched to the order book at ${main.cutover})`);
console.log('SEGMENT                          TRADES  MKTS       P&L  PER TRADE    WIN   95% RANGE PER TRADE     VERDICT');
const line = (name, s) => console.log(`${name.padEnd(32)} ${String(s.trades).padStart(6)} ${String(s.markets).padStart(5)} ${$(s.pnl).padStart(9)} ${c(s.perTrade).padStart(10)} ${pct(s.winRate).padStart(6)}   ${(s.ci ? `${c(s.ci.low)} to ${c(s.ci.high)}` : '--').padEnd(22)}  ${s.verdict}`);
line('All logged trades', main.allLogged);
line('Old fills (market summary)', main.summaryFills);
line('  ...at normal speed', main.summaryFillsNormalSpeed);
line('  ...while the bot was slowed', main.summaryFillsSlow);
line('NEW fills (order book) <- honest', main.orderBookFills);

const audit = out.fillAudit = C.fillAuditReport(jsonl('paper-fill-audit.jsonl'));
console.log(`\nFILL AUDIT: ${audit.checks} pre-trade checks | order-book ask minus summary ask: median ${audit.medianGapCents == null ? '--' : audit.medianGapCents.toFixed(1) + 'c'}, p90 ${audit.p90GapCents == null ? '--' : audit.p90GapCents.toFixed(1) + 'c'} | book worse by >=3c in ${pct(audit.shareBookWorseBy3c)} | no book: ${audit.noBook}`);

console.log('\nREGISTERED TESTS (run exactly as registered; counts only until each threshold)');
const tests = [
  ['Sell early vs hold', () => { const E = require('../lib/exit-hold-log'); const r = E.summarize(E.load(path.join(dataDir, 'exit-vs-hold.jsonl'))); return [r.status, `${r.exits}/${r.minExits} exits` + (r.ci95 ? ` | early ${$(r.earlyExitPnl)} vs hold ${$(r.holdPnl)}` : '')]; }],
  ['Quiet hours', () => { const r = require('../lib/quiet-hours').evaluate(trades); return [r.status, `quiet ${r.quiet.trades} / busy ${r.busy.trades} trades, weekend ${r.weekendTrades}` + (r.status !== 'INSUFFICIENT_DATA' && r.ci ? ` | quiet-busy ${(r.diff * 100).toFixed(2)} pts (${(r.ci.low * 100).toFixed(2)} to ${(r.ci.high * 100).toFixed(2)})` : '')]; }],
  ['Trend filter', () => { const r = require('../lib/trend-filter').evaluate(trades); return [r.status, `${r.counts.counterTrend}/${r.counts.needed.MIN_TRADES} counter-trend trades` + (r.ci ? ` | return/$ ${(r.counterMeanReturn * 100).toFixed(2)}% (${(r.ci.low * 100).toFixed(2)} to ${(r.ci.high * 100).toFixed(2)})` : '')]; }],
  ['Judge model (Baymax Entry)', () => { const r = require('../lib/baymax-entry').evaluate(trades); return [r.status, `${r.counts.test}/${r.counts.needed.MIN_TEST} forward trades, SKIP ${r.counts.skip}/${r.counts.needed.MIN_SKIP} | model ${r.fingerprint}` + (r.ci ? ` | skip-take ${(r.diff * 100).toFixed(2)}% (${(r.ci.low * 100).toFixed(2)} to ${(r.ci.high * 100).toFixed(2)})` : '')]; }],
];
out.tests = {};
for (const [name, run] of tests) {
  let status, detail;
  try { [status, detail] = run(); } catch (err) { status = 'ERROR'; detail = err.message; }
  out.tests[name] = { status, detail };
  console.log(`${name.padEnd(28)} ${status.padEnd(28)} ${detail}`);
}
let leanFiles = 0; try { leanFiles = fs.readdirSync(path.join(dataDir, 'captures')).filter(f => f.endsWith('-lean.jsonl.gz')).length; } catch (_) { /* none */ }
console.log(`${'Lead-lag study'.padEnd(28)} ${(leanFiles ? 'DATA_COLLECTED' : 'NO_CAPTURE_YET').padEnd(28)} ${leanFiles} lean capture file(s) -> npm run lag:study`);
console.log('\nNeeds Supabase (run in Terminal on the Mac): npm run baymax-exit | npm run settlement:shadow-eval');
console.log('Note: every registered test above mixes trades from before and after the fill fix; read verdicts with that in mind.');

fs.mkdirSync(path.join(dataDir, 'checkpoint'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'checkpoint', 'summary.json'), JSON.stringify({ ...out, leanFiles, runTimestamp: new Date().toISOString() }, null, 2));
