#!/usr/bin/env node
'use strict';

// Retired. This pre-agent monolith hard-coded Kalshi's removed integer-cent
// fields and the legacy order endpoint, and had none of the paper-mode, risk or
// kill-switch protections. It is no longer runnable on purpose: a bot that
// misreads prices must not hold an API key that can place orders.
//
// Use `npm start` (server.js). The original source is preserved, inert, at
// legacy/kalshi-bot.pre-fixed-point.js.txt for reference.
console.error('kalshi-bot.js is retired. Run `npm start` instead (see docs/fixed-point-migration.md).');
process.exit(1);
