# PAPER+ Strategy v1

`TRADING_MODE=paper+` enables an aggressive experimental strategy while retaining simulated execution. Only exact `TRADING_MODE=live` can send real Kalshi orders.

Differences from baseline paper:
- directional divergence floor: 4% (configurable)
- general edge floor: 3% (configurable)
- entry contract range: 25c-75c
- entry window: first 10 minutes
- Kelly fraction: 0.20
- time-aware take profit: winners are held more aggressively when substantial time remains, with exit thresholds relaxing closer to settlement

Collector v2 remains independent of strategy/trades and continues sampling real KXBTC15M market observations in paper, paper+, and live modes.
