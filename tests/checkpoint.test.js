'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/checkpoint');

const T0 = Date.parse('2026-11-16T00:00:00Z');
const trade = (i, pnl, o = {}) => ({ orderId: `o${i}`, ticker: `M${i % 12}`, entryTime: T0 + i * 60000, pnl, cost: 2.5, ...o });

test('speedTagger: slow when scans were more than 3 s apart; null without nearby timing', () => {
  const tag = C.speedTagger([
    { ts: '2026-11-16T00:00:00Z', scan_gap_ms: { p50: 2001 }, event_loop_lag_ms: { n: 500 } },
    { ts: '2026-11-16T00:10:00Z', scan_gap_ms: { p50: 5900 }, event_loop_lag_ms: { n: 500 } },
    { ts: '2026-11-16T00:20:00Z', scan_gap_ms: { p50: 9000 }, event_loop_lag_ms: { n: 5 } },   // too few samples: ignored
  ]);
  assert.equal(tag(T0 + 30000), 'normal');
  assert.equal(tag(T0 + 10 * 60000 + 5000), 'slow');
  assert.equal(tag(T0 + 20 * 60000), null);
  assert.equal(C.speedTagger([])(T0), null);
});

test('mainBotReport splits by fill model and speed, and drops duplicates', () => {
  const cutover = T0 + 30 * 60000;
  const trades = [];
  for (let i = 0; i < 30; i++) trades.push(trade(i, i % 5 ? 0.5 : -2.5));          // old fills: 24 wins, 6 losses = -$3.00
  for (let i = 30; i < 60; i++) trades.push(trade(i, -0.2));                        // new fills
  trades.push(trades[0], { orderId: 'bad' });
  const lat = [{ ts: '2026-11-16T00:05:00Z', scan_gap_ms: { p50: 2000 }, event_loop_lag_ms: { n: 100 } }];
  const r = C.mainBotReport(trades, lat, { cutover });
  assert.equal(r.allLogged.trades, 60);
  assert.equal(r.summaryFills.trades, 30);
  assert.ok(Math.abs(r.summaryFills.pnl - (-3)) < 1e-9);
  assert.equal(r.summaryFillsNormalSpeed.trades, 7);                                // only trades within 3 min of the timing row
  assert.equal(r.summaryFillsSlow.trades, 0);
  assert.equal(r.orderBookFills.trades, 30);
  assert.equal(r.orderBookFills.verdict, 'LOSING_BEYOND_LUCK');                     // every trade -20c
  assert.equal(r.summaryFillsSlow.verdict, 'NO_TRADES');
});

test('fillAuditReport measures how far the order book was from the summary', () => {
  const r = C.fillAuditReport([
    { summaryAsk: 0.28, bookAsk: 0.48 }, { summaryAsk: 0.50, bookAsk: 0.50 }, { summaryAsk: 0.60, bookAsk: 0.63 }, { summaryAsk: 0.4, bookAsk: null },
  ]);
  assert.equal(r.checks, 4); assert.equal(r.compared, 3); assert.equal(r.noBook, 1);
  assert.ok(Math.abs(r.medianGapCents - 3) < 1e-6);
  assert.ok(Math.abs(r.shareBookWorseBy3c - 2 / 3) < 1e-9);
});
