'use strict';
// Permanent append-only log of every closed position (data/trades.jsonl).
// bot/state.js keeps only the last 100 closed positions in memory/state.json;
// this file keeps all of them for later analysis. Never read by trading logic.
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'trades.jsonl');
const file = () => process.env.TRADE_LOG || DEFAULT_FILE;
// Under `node --test`, write only when a test points TRADE_LOG at a temp file,
// so test runs never add fake rows to the real log.
const enabled = () => !process.env.NODE_TEST_CONTEXT || !!process.env.TRADE_LOG;

function appendClosed(position) {
  if (!enabled()) return;
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ loggedAt: Date.now(), ...position }) + '\n');
  } catch (err) {
    console.error('[TradeLog] append failed:', err.message);
  }
}

function load(f = file()) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

module.exports = { DEFAULT_FILE, appendClosed, load };
