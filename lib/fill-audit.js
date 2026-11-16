'use strict';
// One line per pre-trade reprice: the price the signal saw, the market-summary ask and
// the order-book ask at that moment. Diagnostic only. Shows how often, and by how much,
// the lagging summary would have flattered a fill.
const fs = require('fs');
const path = require('path');

// Paper entries were priced and filled from the market summary before this moment and
// from the order book after it. Paper results on either side are not comparable.
const ORDERBOOK_FILLS_SINCE = '2026-11-16T23:15:00Z';

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'paper-fill-audit.jsonl');
const file = () => process.env.FILL_AUDIT_LOG || DEFAULT_FILE;
const enabled = () => !process.env.NODE_TEST_CONTEXT || !!process.env.FILL_AUDIT_LOG;

function append(row) {
  if (!enabled()) return;
  try { const f = file(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFile(f, JSON.stringify(row) + '\n', () => {}); } catch (_) { /* diagnostic only */ }
}

module.exports = { ORDERBOOK_FILLS_SINCE, DEFAULT_FILE, append };
