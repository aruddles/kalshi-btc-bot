#!/usr/bin/env node
'use strict';
// Lead-lag study on captured data (read-only). See lib/lag-study.js for the fixed rules.
//
//   npm run capture:markets                        # record (composite BTC quotes on by default)
//   npm run lag:study -- [capture.jsonl ...]       # default: every file in data/captures/

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { analyze } = require('../lib/lag-study');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const KEEP = new Set(['usd_reference_quote', 'derived_quote', 'market_metadata', 'market_settlement', 'sequence_gap', 'kalshi_ws']);

async function readEvents(files) {
  const events = [];
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; }
      if (!KEEP.has(e.type)) continue;
      if (e.type === 'kalshi_ws' && e.payload?.type !== 'orderbook_snapshot') continue;
      if (e.type === 'derived_quote' && e.payload?.quotes) {
        const q = e.payload.quotes;
        e.payload.quotes = { yesBid: q.yesBid, yesAsk: q.yesAsk, noBid: q.noBid, noAsk: q.noAsk }; // drop depth to save memory
      }
      events.push(e);
    }
  }
  return events.sort((a, b) => a.received_at_ms - b.received_at_ms);
}

(async () => {
  try {
    const argv = process.argv.slice(2);
    const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
    const dir = 'data/captures';
    const files = positional.length ? positional : (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) : []);
    if (!files.length) throw new Error('No capture files. Record with: npm run capture:markets');
    const opts = {};
    if (arg('jump-usd')) opts.jumpUsd = Number(arg('jump-usd'));
    const r = analyze(await readEvents(files), opts);
    const out = arg('out', 'data/lag-study/summary.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ files, ...r, runTimestamp: new Date().toISOString() }, null, 2));

    const c = r.coverage, s = r.response;
    const pct = x => (x == null ? '--' : `${(x * 100).toFixed(0)}%`);
    const ci = b => (b ? `${(b.mean * 100).toFixed(2)}c [${(b.lo * 100).toFixed(2)}, ${(b.hi * 100).toFixed(2)}]` : '--');
    console.log('KALSHI vs BTC LEAD-LAG STUDY');
    console.log(`BTC samples ${c.btcSamples} | Kalshi quotes ${c.kalshiQuotes} | markets ${c.markets} | BTC jumps >= $${r.rules.jumpUsd} in ${r.rules.jumpWindowMs / 1000}s: ${c.jumps} | usable ${c.usableEvents}`);
    console.log(`\nKalshi YES mid moved >= ${r.rules.responseMoveCents}c with the jump: already by the jump ${pct(s.respondedWithin?.ms0)} | within 1s ${pct(s.respondedWithin?.ms1000)} | 2s ${pct(s.respondedWithin?.ms2000)} | 5s ${pct(s.respondedWithin?.ms5000)} | not within ${r.rules.maxResponseMs / 1000}s: ${s.noResponseWithinMax}`);
    console.log(`Response time after the jump: median ${s.medianMs ?? '--'}ms (p25 ${s.p25Ms ?? '--'}, p75 ${s.p75Ms ?? '--'})`);
    console.log('\nBuy the jump side at Kalshi\'s ask, 1 contract, after taker fees:');
    console.log('LATENCY  TRADES  30s MARKOUT P&L/contract [95% CI]       SETTLED  SETTLEMENT P&L [95% CI]');
    for (const m of r.markout) {
      console.log(`${String(m.latencyMs).padStart(5)}ms  ${String(m.trades).padStart(6)}  ${ci(m.markoutPnl).padEnd(33)}${m.passes ? ' PASS' : '     '}  ${String(m.settledTrades).padStart(7)}  ${ci(m.settlePnl)}`);
    }
    const xc = r.crossCorrelation.filter(x => x.corr != null);
    console.log(`\nCross-correlation of 1s changes (BTC now vs Kalshi mid k seconds later): ${xc.map(x => `${x.lagSec}s:${x.corr.toFixed(2)}`).join(' ') || '--'}`);
    const best = [...xc].sort((a, b) => b.corr - a.corr)[0];
    if (best) console.log(`Peak at ${best.lagSec}s (${best.corr.toFixed(2)}). A peak above 0s means Kalshi follows BTC by about that many seconds.`);
    console.log(`\nSummary: ${out}`);
  } catch (e) {
    console.error(`[LagStudy] ${e.message}`);
    process.exitCode = 1;
  }
})();
