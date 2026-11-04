const test = require('node:test');
const assert = require('node:assert/strict');
const SignalGenerator = require('../agents/skills/analysis/signal-generator');

test('paper+ holds an early modest winner that baseline paper would take', () => {
  const baseline = new SignalGenerator();
  baseline.context = { config: { KALSHI_TAKER_FEE_RATE: 0.07 } };
  baseline.paperPlus = false;

  const aggressive = new SignalGenerator();
  aggressive.context = { config: { KALSHI_TAKER_FEE_RATE: 0.07 } };
  aggressive.paperPlus = true;

  const now = Date.now();
  const positions = [{ orderId: 'p1', ticker: 'T', side: 'yes', closeTime: now + 6 * 60 * 1000, filledContracts: 5, contracts: 5, priceDecimal: 0.50, totalCost: 2.50 }];
  const markets = [{ ticker: 'T', yesBid: 0.60, noBid: 0.40, feeMultiplier: 1 }];

  assert.equal(baseline._generateTakeProfitSignals(positions, markets).length, 1);
  assert.equal(aggressive._generateTakeProfitSignals(positions, markets).length, 0);
});
