# Dashboard v2.2 — Real-Time Telemetry

- Unified PAPER / PAPER+ / LIVE dashboard retained from v2.1.
- Startup bootstrap pushes persisted/current state plus recent in-memory Binance history as soon as available.
- Binance and market state continue to stream independently of strategy scan cycles.
- Market countdown ticks locally every second from the authoritative close timestamp.
- BTC chart uses target-relative green/red segments and a persistent interpolated live dot.
- The live dot never initializes from zero/null, preventing bottom-of-chart flicker on redraws.
- Target remains visible as a labeled reference line.
- Branding updated to AIDEN'S KALSHIBOT / TRADING SYSTEM with a restrained depth pass.
- No trading thresholds, execution paths, ML labels, or collector semantics changed in this dashboard release.
