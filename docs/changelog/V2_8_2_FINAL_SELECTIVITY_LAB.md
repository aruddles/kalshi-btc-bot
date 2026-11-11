# v2.8.2 FINAL Selectivity Lab

This patch adds a controlled PAPER-only entry-selectivity experiment to the known-good v2.8.1 Model Arena. It does not add five ML models. FINAL-1, FINAL-3, FINAL-5, FINAL-8 and FINAL-12 consume the same calibrated `FINAL_CHALLENGER_1K` probability and the same immutable executable quote snapshot; only minimum after-fee edge differs: 1%, 3%, 5%, 8%, 12%.

Each policy starts at $100, sizes one contract, uses the existing Kalshi taker-fee model, respects displayed top-of-book depth, enters at most once per ticker, and holds to actual Kalshi settlement. State is stored separately in `data/final-selectivity-state.json` using atomic temp-file rename. No historical lab trades are backfilled. Existing Model Arena state remains in `data/model-arena-state.json` and is not migrated or reset by this experiment.

Metrics include cash/equity, trades and settled trades, W-L/win rate, realized P&L, fees, expectancy, profit factor, ROI, average winner/loser, average entry price/raw edge/after-fee edge, max drawdown, no-trades, YES/NO split accounting, open positions and the nested opportunity funnel. The funnel reports evaluated markets and entries reaching >=1/3/5/8/12%.

The experiment is frozen to `FINAL_CHALLENGER_1K`. It never reads `historical-ml-v2-2000-markets.jsonl`, does not retrain from a future 2K reconstruction, and does not change Champion/Challenger training, calibration, schemas, chronology, Collector v2, or benchmarking.

The dashboard preserves `KALSHIBOT MODEL ARENA`, its six bots, BTC/target chart, leaderboard, open positions, console, and collapsed legacy diagnostics. A compact `FINAL SELECTIVITY LAB — 1K CHALLENGER` table is added near FINAL. `GET /api/final-selectivity` returns JSON with status, model identity, start timestamp, policies, funnel, open positions and recent settlements.

Safety boundary: the lab has no OrderExecutor, real Kalshi order, real account balance, RiskManager execution, Collector, Supabase, or training-label dependency. `TRADING_MODE=live` does not change its simulation-only behavior. PAPER results never become ML labels; actual Kalshi settlement remains the training target.

Interpretation: lower thresholds should create more trades; higher thresholds trade frequency for claimed edge. Compare expectancy/trade, total after-fee P&L, profit factor, ROI and drawdown together. Small samples are research evidence, not proof. Top-of-book PAPER simulation also cannot reproduce queue position or deeper-book slippage.
