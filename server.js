#!/usr/bin/env node

/**
 * Kalshibot Server — Agentic Architecture
 *
 * Entry point that creates the MasterAgent (which owns the Orchestrator,
 * SkillRegistry, and all sub-agent skills), wires up the Express/Socket.io
 * UI layer, and manages the bot lifecycle.
 *
 * Architecture:
 *   server.js → MasterAgent → Orchestrator → Skills
 *
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { MasterAgent } = require('./agents');

const PORT = process.env.PORT || 3333;
const RUNTIME_MODE_FILE = path.join(__dirname, '.runtime-mode.json');
function normalizedMode(value) {
  const m = String(value || 'paper').toLowerCase();
  return m === 'live' ? 'live' : (m === 'paper+' ? 'paper+' : 'paper');
}
function persistedMode() {
  try { return normalizedMode(JSON.parse(fs.readFileSync(RUNTIME_MODE_FILE, 'utf8')).mode); } catch (_) { return null; }
}

// Control endpoints (start/stop/halt) can start live trading, so the server listens on
// loopback only unless you opt in to remote access (and then an ADMIN_TOKEN is required).
const HOST = process.env.HOST || '127.0.0.1';
const IS_LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!IS_LOOPBACK && !ADMIN_TOKEN) {
  console.error(`Refusing to listen on ${HOST} without ADMIN_TOKEN: the control endpoints can start live trading.`);
  process.exit(2);
}

// Numeric env helper that keeps an explicit 0 (unlike `parseFloat(x) || default`).
const envNum = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v);
};

// Build config from env
const config = {
  KALSHI_API_KEY: process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem',
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://external-api.kalshi.com',

  // Modes: paper = baseline simulation; paper+ = aggressive experimental simulation; live = real orders.
  // Only the exact string 'live' is ever allowed onto the real-order path.
  TRADING_MODE: persistedMode() || normalizedMode(process.env.TRADING_MODE || 'paper'),
  PAPER_BALANCE: envNum('PAPER_BALANCE', 100),
  PAPER_LATENCY_PENALTY: envNum('PAPER_LATENCY_PENALTY', 0.01),
  KALSHI_ORDER_API: (process.env.KALSHI_ORDER_API || 'v2').toLowerCase(),

  POLYMARKET_GAMMA_API: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_API: 'https://clob.polymarket.com',

  SERIES_TICKER: process.env.SERIES_TICKER || 'KXBTC15M',

  // Probability model that drives trading: gbm_point (default) | settlement_avg | settlement_brti.
  // The other models are always computed and logged in shadow.
  PROB_MODEL: ['gbm_point', 'settlement_avg', 'settlement_brti'].includes(process.env.PROB_MODEL) ? process.env.PROB_MODEL : 'gbm_point',
  // Composite Coinbase/Kraken/Bitstamp BTC/USD feed (BRTI proxy). Market data only.
  USD_REFERENCE_ENABLED: process.env.USD_REFERENCE_ENABLED !== 'false',
  SLOT_DURATION: parseInt(process.env.SLOT_DURATION) || 900, // 15 min

  // Strategy thresholds
  MIN_EDGE: parseFloat(process.env.MIN_EDGE) || 10.0,
  // Backtest-optimized: higher threshold to filter overconfident signals
  MIN_DIVERGENCE: parseFloat(process.env.MIN_DIVERGENCE) || 15.0,
  TRADING_WINDOW: parseInt(process.env.TRADING_WINDOW) || 4, // minutes
  // Backtest-optimized: contracts above 65c have terrible payoff ratio
  MIN_CONTRACT_PRICE: parseInt(process.env.MIN_CONTRACT_PRICE) || 35, // cents
  MAX_CONTRACT_PRICE: parseInt(process.env.MAX_CONTRACT_PRICE) || 65, // cents

  // 1H Trend indicator
  TREND_ENABLED: process.env.TREND_ENABLED !== 'false',
  TREND_FAST_PERIOD: parseInt(process.env.TREND_FAST_PERIOD) || 720,     // 12 min
  TREND_SLOW_PERIOD: parseInt(process.env.TREND_SLOW_PERIOD) || 2700,    // 45 min
  TREND_ROC_WINDOW: parseInt(process.env.TREND_ROC_WINDOW) || 1800,      // 30 min
  TREND_ROC_THRESHOLD: parseFloat(process.env.TREND_ROC_THRESHOLD) || 0.02,
  TREND_BOOST: parseFloat(process.env.TREND_BOOST) || 0.25,
  TREND_PENALTY: parseFloat(process.env.TREND_PENALTY) || 0.40,

  KALSHI_TAKER_FEE_RATE: envNum('KALSHI_TAKER_FEE_RATE', 0.07),
  KALSHI_FEE_MULTIPLIER: envNum('KALSHI_FEE_MULTIPLIER', 1),

  // Isolated ML PAPER HOLD research runtime. Never routes to LIVE execution.
  ML_PAPER_ENABLED: process.env.ML_PAPER_ENABLED === 'true',
  MODEL_ARENA_STARTING_CASH: Number(process.env.MODEL_ARENA_STARTING_CASH || 100),
  MODEL_ARENA_CONTRACTS: Number(process.env.MODEL_ARENA_CONTRACTS || 1),
  BAYMAX5K_FORWARD_ENABLED: process.env.BAYMAX5K_FORWARD_ENABLED !== 'false',
  BAYMAX5K_FORWARD_STARTING_CASH: envNum('BAYMAX5K_FORWARD_STARTING_CASH', 100),
  ML_PAPER_STARTING_CASH: envNum('ML_PAPER_STARTING_CASH', 100),
  ML_PAPER_MIN_EDGE: envNum('ML_PAPER_MIN_EDGE', 0.05),
  ML_PAPER_MAX_CONTRACTS: envNum('ML_PAPER_MAX_CONTRACTS', 1),
  ML_PAPER_SPECIALIST_STARTING_CASH: envNum('ML_PAPER_SPECIALIST_STARTING_CASH', 100),
  ML_PAPER_MAX_EXPOSURE: envNum('ML_PAPER_MAX_EXPOSURE', 10),

  // Risk limits (enforced in agents/skills/trading/risk-manager.js)
  MAX_EXPOSURE_PCT: envNum('MAX_EXPOSURE_PCT', 0.5),
  SESSION_REDUCE_PCT: envNum('SESSION_REDUCE_PCT', 0.10),
  SESSION_PAUSE_PCT: envNum('SESSION_PAUSE_PCT', 0.20),
  SESSION_HARD_STOP_PCT: envNum('SESSION_HARD_STOP_PCT', 0.30),
  SESSION_PAUSE_MINUTES: envNum('SESSION_PAUSE_MINUTES', 15),
  MAX_SESSION_LOSS_USD: envNum('MAX_SESSION_LOSS_USD', 0),
  MAX_CONSECUTIVE_FAILURES: envNum('MAX_CONSECUTIVE_FAILURES', 5),
  BALANCE_FLOOR: envNum('BALANCE_FLOOR', 5),
  MAX_SPOT_AGE_MS: envNum('MAX_SPOT_AGE_MS', 5000),

  // Position sizing
  // Fractional Kelly is applied to fee-adjusted contract economics
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.08,
  MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE) || 5,
  MAX_POSITIONS_PER_CONTRACT: parseInt(process.env.MAX_POSITIONS_PER_CONTRACT) || 1,
  MAX_TOTAL_OPEN_POSITIONS: parseInt(process.env.MAX_TOTAL_OPEN_POSITIONS) || 10,
};

// Express + Socket.io
const app = express();
const server = http.createServer(app);
// Same-origin only (the dashboard is served from this server); no wildcard CORS.
const io = new Server(server);
app.use(express.json({ limit: '32kb' }));

// Read-only console mirror for the local dashboard. No shell/command execution is exposed.
const consoleBuffer = [];
const rawConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
function mirrorConsole(level, args) {
  const message = args.map(v => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch (_) { return String(v); } })()).join(' ');
  const row = { ts: Date.now(), level, message };
  consoleBuffer.push(row);
  if (consoleBuffer.length > 300) consoleBuffer.shift();
  io.emit('console', row);
}
for (const level of ['log','warn','error']) {
  console[level] = (...args) => { rawConsole[level](...args); mirrorConsole(level, args); };
}


// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Create the MasterAgent
const agent = new MasterAgent(config);

// Guard for endpoints that change what the bot does. A browser on this machine could
// otherwise be tricked by any web page into POSTing here (CSRF), so cross-origin
// requests are refused; with ADMIN_TOKEN set a bearer token is also required.
function controlOnly(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch (_) { /* malformed origin */ }
    if (!ok) return res.status(403).json({ error: 'cross-origin request refused' });
  }
  if (ADMIN_TOKEN && req.get('authorization') !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'ADMIN_TOKEN required' });
  }
  next();
}

function riskSkill() { return agent.registry.get('risk-manager'); }
function guard() { return agent.registry.get('kalshi-market-data')?.client?.guard || null; }
function kalshiClient() { return agent.registry.get('kalshi-market-data')?.client || null; }
function currentMode() { return kalshiClient()?.tradingMode || config.TRADING_MODE; }
function openPositionCount() { return agent.state?.getSnapshot?.().openPositions?.length || 0; }
function persistMode(mode) {
  try { fs.writeFileSync(RUNTIME_MODE_FILE, JSON.stringify({ mode }, null, 2)); } catch (e) { console.warn('[Server] Could not persist runtime mode:', e.message); }
}

// Rolling 1-hour history of the front market's YES midpoint (percent), so the dashboard
// chart's YES CHANCE view has data for 5M/15M/1H as soon as a browser connects.
const CHART_HISTORY_MS = 60 * 60 * 1000;
const chanceHistory = [];
function referenceSkill() { return agent.registry.get('usd-reference-feed'); }
setInterval(() => {
  const now = Date.now();
  // Stream the composite USD (BRTI-proxy) price to dashboards once a second.
  const ref = referenceSkill()?.getFeed?.();
  if (ref?.isHealthy?.()) io.emit('price:reference', { price: ref.latest.price, ts: ref.latest.timestamp, venues: ref.latest.venues });
  const m = agent.state?.activeMarkets?.[0];
  while (chanceHistory.length && now - chanceHistory[0].t > CHART_HISTORY_MS) chanceHistory.shift();
  if (!agent.running || !m?.ticker || (m.refreshedAt && now - m.refreshedAt > 15000)) return;
  const bid = Number(m.yesBid), ask = Number(m.yesAsk);
  if (!(bid > 0 && ask > 0 && bid < 1 && ask < 1 && ask >= bid)) return;
  chanceHistory.push({ t: now, ticker: m.ticker, v: Math.round((bid + ask) * 5000) / 100 });
}, 1000).unref();

function dashboardBootstrap() {
  const snapshot = agent.state?.getSnapshot?.() || null;
  let priceHistory = [];
  try {
    const feed = agent.registry.get('binance-price-feed')?.getFeed?.();
    const cutoff = Date.now() - CHART_HISTORY_MS;
    if (Array.isArray(feed?.priceHistory)) priceHistory = feed.priceHistory.filter(x => x.timestamp >= cutoff).map(x => ({ t: x.timestamp, p: x.price }));
  } catch (_) { /* skill may still be warming */ }
  const refFeed = referenceSkill()?.getFeed?.();
  const referenceHistory = (refFeed?.priceHistory || []).filter(x => x.timestamp >= Date.now() - CHART_HISTORY_MS).map(x => ({ t: x.timestamp, p: x.price }));
  return { snapshot, priceHistory, referenceHistory, chanceHistory: chanceHistory.slice(), ts: Date.now() };
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), botRunning: agent.running });
});

// Bot control: start/stop
app.post('/api/bot/start', controlOnly, (req, res) => {
  if (currentMode() === 'live' && req.body?.confirm !== 'ENABLE LIVE') {
    return res.status(400).json({ error: 'live_start_confirmation_required' });
  }
  if (agent.running) {
    return res.json({ status: 'already_running' });
  }
  // Respond immediately — start() is long-running (connects to feeds, waits for prices)
  res.json({ status: 'starting' });
  agent.start()
    .then(() => {
      io.emit('bot:status', { running: true });
      io.emit('bootstrap', dashboardBootstrap());
    })
    .catch((err) => {
      console.error('[Server] Bot start failed:', err.message);
      io.emit('bot:status', { running: false, error: err.message });
    });
});

app.post('/api/bot/stop', controlOnly, (req, res) => {
  if (!agent.running) {
    return res.json({ status: 'already_stopped' });
  }
  agent.stop();
  io.emit('bot:status', { running: false });
  res.json({ status: 'stopped' });
});

// Restart the server process (reloads code). Requires the run-forever loop
// (`npm run forever`) to come back up; without it this just stops the server.
const restart = require('./lib/server-restart');
const DATA_DIR = path.join(__dirname, 'data');
app.post('/api/server/restart', controlOnly, (req, res) => {
  const check = restart.canRestart(currentMode());
  if (!check.ok) return res.status(409).json({ error: check.error });
  restart.writeMarker(DATA_DIR, { running: agent.running, mode: currentMode() });
  res.json({ status: 'restarting', resumeTrading: agent.running });
  console.log('[Server] Restart requested from dashboard');
  setTimeout(() => {
    try { if (agent.state) agent.state.saveNow(); agent.stop(); } catch (err) { console.error('[Server] restart cleanup:', err.message); }
    server.close();
    process.exit(0);
  }, 300);
});

// Latency telemetry (diagnostic only).
app.get('/api/latency', (req, res) => res.json(require('./lib/latency-monitor').monitor.summary()));

// Main-bot panel + scorecard (display only).
app.get('/api/main-bot', (req, res) => {
  try {
    const out = require('./lib/main-bot-summary').load(agent.state);
    // One-line research total (since the dashboard cutoff), for the collapsed section.
    const D = require('./lib/dashboard-since'), since = D.sinceMs();
    let bots = 0, trades = 0, pnl = 0, positive = 0;
    for (const set of [agent.modelArena?.portfolios, agent.finalSelectivityLab?.policies, agent.baymax5kForward?.policies]) {
      for (const p of Object.values(set || {})) { const v = D.viewSince(p, since); bots++; trades += v.trades.length; pnl += v.realizedPnl; if (v.realizedPnl > 0) positive++; }
    }
    out.research = { bots, trades, pnl, positive };
    res.json(out);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bot/status', (req, res) => {
  res.json({ running: agent.running, mode: currentMode() });
});

app.get('/api/bootstrap', (req, res) => res.json(dashboardBootstrap()));

// Runtime mode control. Mode changes are refused while a position is open so
// simulated and real positions can never cross execution environments.
app.post('/api/mode', controlOnly, (req, res) => {
  const requested = String(req.body?.mode || '').toLowerCase();
  if (!['paper', 'paper+', 'live'].includes(requested)) return res.status(400).json({ error: 'mode must be paper, paper+, or live' });
  if (requested === 'live' && req.body?.confirm !== 'ENABLE LIVE') return res.status(400).json({ error: 'live_confirmation_required' });
  const before = currentMode();
  if (requested === before) return res.json({ status: 'unchanged', mode: before });
  const open = openPositionCount();
  if (open > 0) return res.status(409).json({ error: 'close_positions_before_mode_change', openPositions: open, mode: before });
  config.TRADING_MODE = requested;
  const client = kalshiClient();
  if (client) client.setTradingMode(requested);
  persistMode(requested);
  console.log(`[Server] Trading mode changed: ${before.toUpperCase()} -> ${requested.toUpperCase()}${requested === 'live' ? ' (REAL ORDERS ENABLED)' : ' (simulation)'}`);
  io.emit('mode', { mode: requested });
  res.json({ status: 'changed', mode: requested });
});

app.get('/api/console', (req, res) => res.json({ lines: consoleBuffer.slice(-200) }));

// Risk / safety status: mode, halts, session loss.
app.get('/api/risk', (req, res) => {
  const g = guard();
  res.json({ mode: currentMode(), guard: g ? g.status() : null, risk: riskSkill()?.context ? riskSkill().getStatus() : null });
});

// Emergency halt: blocks all NEW entries immediately (exits stay allowed). Resume is explicit.
app.post('/api/halt', controlOnly, (req, res) => {
  const g = guard();
  if (!g) return res.status(409).json({ error: 'bot not started' });
  g.halt('manual_halt_api');
  res.json({ status: 'halted', guard: g.status() });
});

app.post('/api/resume', controlOnly, (req, res) => {
  const g = guard();
  if (!g) return res.status(409).json({ error: 'bot not started' });
  const ok = g.resume();
  res.status(ok ? 200 : 409).json({ status: ok ? 'resumed' : 'hard_halt_requires_restart', guard: g.status() });
});

// API: get current state
app.get('/api/state', (req, res) => {
  if (agent && agent.state) {
    res.json(agent.state.getSnapshot());
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: force save state to disk
app.post('/api/save', controlOnly, (req, res) => {
  if (agent && agent.state) {
    agent.state.saveNow();
    res.json({ status: 'saved' });
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: ML pipeline status
app.get('/api/ml', (req, res) => {
  const mlScorer = agent.registry.get('ml-signal-scorer');
  if (mlScorer) {
    const mlPipeline = require('./lib/ml-pipeline');
    res.json(mlPipeline.describe());
  } else {
    res.json({ trained: false, note: 'ML scorer not initialized' });
  }
});

app.get('/api/ml-challengers', (req, res) => { const p=require('./lib/ml-pipeline'); res.json(p.challengers?.describe?.() || {status:'UNAVAILABLE',shadowOnly:true}); });

app.get('/api/ml-paper', (req, res) => { res.json(agent.getMlPaperSnapshot?.() || { enabled:false,status:'OFF',simulated:true }); });
app.get('/api/model-arena', (req,res)=>{ res.json(agent.getModelArenaSnapshot?.() || {enabled:false,status:'OFF',simulated:true,bots:{}}); });
app.get('/api/final-selectivity', (req,res)=>{ res.json(agent.getFinalSelectivitySnapshot?.() || {status:'OFF',simulated:true,modelIdentity:'FINAL_CHALLENGER_1K',policies:{}}); });
// Composite BTC/USD (BRTI proxy): venue health, basis correction and strike accuracy vs Binance.
app.get('/api/reference', (req, res) => res.json(referenceSkill()?.getStatus?.() || { healthy: false, running: false }));
app.get('/api/baymax-5k-forward', (req,res)=>{ res.json(agent.getBaymax5kForwardSnapshot?.() || {status:'OFF',simulated:true,liveOrderCapable:false,modelIdentity:'BAYMAX_FINAL_5K',policies:{}}); });

// API: get agent skill registry status
app.get('/api/skills', (req, res) => {
  res.json({
    skills: agent.registry.describeAll(),
    orchestrator: agent.orchestrator.describe(),
  });
});

// Socket.io: push updates to UI
io.on('connection', (socket) => {
  console.log(`[Server] UI connected: ${socket.id}`);

  // Send full snapshot on connect
  socket.emit('bot:status', { running: agent.running });
  socket.emit('mode', { mode: currentMode() });
  socket.emit('console:init', consoleBuffer.slice(-120));
  socket.emit('bootstrap', dashboardBootstrap());
  if (agent.state) {
    socket.emit('snapshot', agent.state.getSnapshot());
  }

  // Forward state events to this socket
  const events = [
    'price:binance', 'price:redstone', 'balance', 'markets',
    'intent', 'model', 'trade',
    'order:pending', 'order:removed',
    'position:open', 'position:close', 'position:updated',
    'stats', 'connection:kalshi', 'connection:polymarket', 'connection:binance',
  ];

  const handlers = {};
  for (const event of events) {
    handlers[event] = (data) => socket.emit(event, data);
    if (agent.state) {
      agent.state.on(event, handlers[event]);
    }
  }

  socket.on('disconnect', () => {
    console.log(`[Server] UI disconnected: ${socket.id}`);
    for (const event of events) {
      try {
        if (agent.state) {
          agent.state.removeListener(event, handlers[event]);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});

// Start server, then agent
server.listen(PORT, HOST, () => {
  console.log(`\n  KALSHIBOT MISSION CONTROL (Agentic Architecture)`);
  console.log(`  Dashboard:  http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Mode:       ${config.TRADING_MODE === 'live' ? '*** LIVE — REAL ORDERS ***' : (config.TRADING_MODE === 'paper+' ? 'PAPER+ (aggressive simulated strategy, no real orders)' : 'PAPER (simulated fills, no real orders)')}`);
  console.log(`  Skills API: http://localhost:${PORT}/api/skills`);
  console.log(`  Config: ${config.SERIES_TICKER} | MinEdge=${config.MIN_EDGE}% | MinDiv=${config.MIN_DIVERGENCE}% | MaxPos=$${config.MAX_POSITION_SIZE}\n`);

  // Bot does NOT auto-start — user controls via dashboard toggle —
  // except right after a dashboard restart of a running PAPER/PAPER+ bot.
  if (restart.consumeAutostart(DATA_DIR, currentMode())) {
    console.log('  Restarted from dashboard: resuming trading.\n');
    agent.start()
      .then(() => { io.emit('bot:status', { running: true }); io.emit('bootstrap', dashboardBootstrap()); })
      .catch((err) => { console.error('[Server] Bot auto-resume failed:', err.message); io.emit('bot:status', { running: false, error: err.message }); });
  } else {
    console.log('  Bot is IDLE. Use the dashboard toggle to start trading.\n');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  if (agent.state) agent.state.saveNow();
  agent.stop();
  server.close();
  process.exit(0);
});
