# Dashboard v2.1

Unified dashboard for PAPER, PAPER+, and LIVE.

- Smooth rolling BTC chart with green-above-target / red-below-target rendering.
- Persistent labeled Kalshi target line and animated latest-price dot.
- Structured decision telemetry (signal, side, model probability, executable ask, net EV, edge, trend).
- Runtime PAPER / PAPER+ / LIVE selector from localhost.
- LIVE requires explicit confirmation both when switching into LIVE and when starting the bot while LIVE is selected.
- Mode changes are blocked while positions are open to prevent simulated/live position crossover.
- Mode selection persists in `.runtime-mode.json` (not included in release archives).
- HALT / RESUME controls remain available without stopping market feeds or the ML collector.
- Read-only live console mirror in the dashboard; no shell execution is exposed.
- ML collector remains independent of trading mode.
