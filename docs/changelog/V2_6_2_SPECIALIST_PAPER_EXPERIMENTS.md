# v2.6.2 Independent Specialist Paper Experiments

ML PAPER now treats EARLY (5-15m), LATE (2-5m), and FINAL (0-2m) as independent forward research portfolios. Each specialist may enter the same KXBTC15M ticker once, so an EARLY entry no longer prevents later LATE/FINAL experiments. Default sizing is one contract and each specialist has an independent $100 research bankroll. Positions remain HOLD-to-settlement only.

The v1 local ledger is migrated from durable `activeSpecialist`/`model` fields. Existing trades and positions are preserved; v1 aggregate P&L remains historical aggregate accounting, while independent specialist bankrolls begin at the configured research bankroll after migration. Entry guards are rebuilt as `SPECIALIST:ticker` keys.

Dashboard ML PAPER accounting now exposes EARLY/LATE/FINAL records, P&L, expectancy, profit factor, markets evaluated, snapshot evaluations, open positions/exposure and specialist cash. Duplicate snapshots remain diagnostic and do not prevent another specialist from testing the same ticker.

New entries and settlements emit searchable `[MLPaper][EARLY|LATE|FINAL]` logs. ML PAPER remains isolated from OrderExecutor/Kalshi live submission and cannot affect settlement labels.
