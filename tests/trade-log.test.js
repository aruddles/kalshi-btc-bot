const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.TRADE_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-')), 'trades.jsonl');
const TL = require('../lib/trade-log');

test('every closed position is appended permanently, beyond the 100-position cap', () => {
  const BotState = require('../bot/state');
  const s = Object.create(BotState.prototype);
  Object.assign(s, { openPositions: [], closedPositions: [], stats: { totalTrades: 0, wins: 0, losses: 0, totalPnL: 0, grossWins: 0, grossLosses: 0, streak: 0, strategyStats: {}, startTime: Date.now() }, emit() {}, _scheduleSave() {}, logTrade() {} });
  for (let i = 0; i < 105; i++) {
    s.openPositions.push({ orderId: 'o' + i, ticker: 'T', side: 'yes', type: 'DIRECTIONAL_YES' });
    try { s.closePosition('o' + i, { pnl: 1, won: true, exitType: 'SETTLEMENT' }); } catch (_) { /* stats details may need more state */ }
  }
  const rows = TL.load();
  assert.equal(rows.length, 105);
  assert.equal(rows[104].orderId, 'o104');
  assert.ok(s.closedPositions.length <= 100);
});
