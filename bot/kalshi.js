const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const {
  parseMarket, parseOrder, parseCreateOrderResponse, parseBalance, parsePosition,
  buildV2OrderBody, specFromOrderData, formatPrice, formatCount,
} = require('../lib/kalshi-format');
const { PaperBroker } = require('../lib/paper-broker');
const { TradingGuard, TradingBlockedError } = require('../lib/trading-guard');
const { normalizeSnapshot, executableQuotes } = require('../lib/kalshi-orderbook');

const V2_ORDERS_PATH = '/trade-api/v2/portfolio/events/orders';
const LEGACY_ORDERS_PATH = '/trade-api/v2/portfolio/orders';

/**
 * Kalshi REST client.
 *
 * Wire format: Kalshi returns prices as dollar strings and counts as `_fp`
 * strings; this client parses them (lib/kalshi-format) and hands the rest of the
 * bot the same shapes it always used (dollar numbers, `*Cents` for display,
 * order costs/fees in cents).
 *
 * Every order goes through placeOrder(), which is the one choke point for:
 *   - TRADING_MODE: 'paper' (default) simulates fills; only 'live' sends orders
 *   - the TradingGuard (kill switch / halts / pauses) for new entries
 *   - translating the bot's order description to Kalshi's V2 order endpoint
 */
class KalshiClient {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.privateKeyPem = null;
    this.baseUrl = config.KALSHI_API_BASE || process.env.KALSHI_API_BASE || 'https://external-api.kalshi.com';

    const mode = String(config.TRADING_MODE || process.env.TRADING_MODE || 'paper').toLowerCase();
    this.tradingMode = mode === 'live' ? 'live' : (mode === 'paper+' ? 'paper+' : 'paper');
    this.orderApi = String(config.KALSHI_ORDER_API || process.env.KALSHI_ORDER_API || 'v2').toLowerCase();
    this.guard = config.guard || new TradingGuard();
    this._diagnosticBalanceCache = null;
    this._diagnosticBalanceAt = 0;

    const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    this.paper = this.tradingMode !== 'live'
      ? new PaperBroker({
        startingBalance: num(config.PAPER_BALANCE ?? process.env.PAPER_BALANCE, 100),
        feeRate: num(config.KALSHI_TAKER_FEE_RATE ?? process.env.KALSHI_TAKER_FEE_RATE, 0.07),
        feeMultiplier: num(config.KALSHI_FEE_MULTIPLIER ?? process.env.KALSHI_FEE_MULTIPLIER, 1),
        latencyPenalty: num(config.PAPER_LATENCY_PENALTY ?? process.env.PAPER_LATENCY_PENALTY, 0.01),
      })
      : null;
  }

  get isPaper() { return this.tradingMode !== 'live'; }

  setTradingMode(mode) {
    const m = String(mode || 'paper').toLowerCase();
    const next = m === 'live' ? 'live' : (m === 'paper+' ? 'paper+' : 'paper');
    if (next === this.tradingMode) return this.tradingMode;
    this.tradingMode = next;
    this.config.TRADING_MODE = next;
    if (next === 'live') {
      this.paper = null;
    } else if (!this.paper) {
      const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
      this.paper = new PaperBroker({
        startingBalance: num(this.config.PAPER_BALANCE ?? process.env.PAPER_BALANCE, 100),
        feeRate: num(this.config.KALSHI_TAKER_FEE_RATE ?? process.env.KALSHI_TAKER_FEE_RATE, 0.07),
        feeMultiplier: num(this.config.KALSHI_FEE_MULTIPLIER ?? process.env.KALSHI_FEE_MULTIPLIER, 1),
        latencyPenalty: num(this.config.PAPER_LATENCY_PENALTY ?? process.env.PAPER_LATENCY_PENALTY, 0.01),
      });
    }
    return this.tradingMode;
  }

  loadPrivateKey() {
    if (!this.privateKeyPem) {
      // Support base64-encoded key from env var (for Vercel/serverless)
      if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
        this.privateKeyPem = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
      } else {
        const keyPath = this.config.KALSHI_PRIVATE_KEY_PATH || './kalshi_private_key.pem';
        if (!fs.existsSync(keyPath)) {
          throw new Error(`Private key not found: ${keyPath}. Set KALSHI_PRIVATE_KEY_BASE64 env var for serverless deployments.`);
        }
        this.privateKeyPem = fs.readFileSync(keyPath, 'utf8');
      }
    }
    return this.privateKeyPem;
  }

  generateAuth(method, apiPath) {
    const pem = this.loadPrivateKey();
    const timestampMs = Date.now().toString();
    const pathWithoutQuery = apiPath.split('?')[0];
    const message = timestampMs + method + pathWithoutQuery;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    const signature = sign.sign({
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, 'base64');

    return {
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': this.config.KALSHI_API_KEY,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      },
    };
  }

  _onHttpError(error) {
    // An auth failure means every later request will fail too: stop entries for good.
    if (error?.response?.status === 401) this.guard.halt('auth_failure_401', { hard: true });
    throw error;
  }

  async get(apiPath) {
    const auth = this.generateAuth('GET', apiPath);
    return axios.get(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 }).catch(e => this._onHttpError(e));
  }

  async post(apiPath, body) {
    const auth = this.generateAuth('POST', apiPath);
    return axios.post(`${this.baseUrl}${apiPath}`, body, { ...auth, timeout: 8000 }).catch(e => this._onHttpError(e));
  }

  async delete(apiPath) {
    const auth = this.generateAuth('DELETE', apiPath);
    return axios.delete(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 }).catch(e => this._onHttpError(e));
  }

  async fetchBalance() {
    try {
      let balance;
      if (this.paper) {
        balance = this.paper.balance();
      } else {
        const resp = await this.get('/trade-api/v2/portfolio/balance');
        balance = parseBalance(resp.data);
      }
      this.state?.updateBalance?.(balance);
      this.state?.updateKalshiConnection?.(true);
      return balance;
    } catch (error) {
      this.state?.updateKalshiConnection?.(false);
      throw error;
    }
  }

  /** Raw market objects (the capture script records them untouched). */
  async discoverMarkets(seriesTicker) {
    const apiPath = `/trade-api/v2/markets?series_ticker=${seriesTicker}&limit=20&status=open`;
    const resp = await this.get(apiPath);
    return resp.data.markets || [];
  }

  /** Normalize a raw market object (see lib/kalshi-format.parseMarket). */
  parseMarket(raw) { return parseMarket(raw); }

  async fetchMarket(ticker) {
    try {
      const resp = await this.get(`/trade-api/v2/markets/${ticker}`);
      return parseMarket(resp.data.market);
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  /**
   * Place an order described in the bot's internal shape:
   *   { ticker, action: 'buy'|'sell', side: 'yes'|'no', count,
   *     yes_price|no_price (cents) or yes_price_dollars|no_price_dollars,
   *     time_in_force?, reduce_only?, client_order_id? }
   * Returns a normalized order: { order_id, status, fill_count, remaining_count,
   * average_fill_price, taker_fill_cost (cents), taker_fees (cents) }.
   */
  async placeOrder(orderData) {
    const spec = specFromOrderData(orderData);

    if (spec.action === 'buy') {
      const blocked = this.guard.blockReason();
      if (blocked) throw new TradingBlockedError(blocked);
    } else if (this.guard.hard) {
      throw new TradingBlockedError(`hard_halt:${this.guard.reason}`);
    }

    if (this.paper) {
      // Match against a FRESH book, as a real order would see.
      const market = await this.fetchMarket(spec.ticker);
      return this.paper.place(spec, market);
    }

    if (this.orderApi === 'legacy') {
      // Emergency fallback only; the legacy endpoint is being retired by Kalshi.
      const body = {
        ticker: spec.ticker, action: spec.action, side: spec.outcomeSide, count: spec.count, type: 'limit',
        client_order_id: spec.clientOrderId,
        [spec.outcomeSide === 'yes' ? 'yes_price' : 'no_price']: Math.round(spec.limitPrice * 100),
      };
      if (spec.timeInForce === 'immediate_or_cancel') body.time_in_force = 'immediate_or_cancel';
      const resp = await this.post(LEGACY_ORDERS_PATH, body);
      return parseOrder(resp.data.order);
    }

    // Route the order explicitly. Kalshi V2 uses subaccount 0 for the primary
    // account; exchange_index -1 requires ticker-based shard auto-routing.
    // Both can be overridden in .env for non-primary/restricted setups.
    spec.subaccount = Number(this.config.KALSHI_SUBACCOUNT ?? process.env.KALSHI_SUBACCOUNT ?? 0);
    spec.exchangeIndex = Number(this.config.KALSHI_EXCHANGE_INDEX ?? process.env.KALSHI_EXCHANGE_INDEX ?? -1);
    const body = buildV2OrderBody(spec);
    // Live diagnostics: fetch exchange state immediately before submission.
    // This intentionally logs only public market data and non-secret account economics.
    const localBal = this.state?.balance || {};
    let freshBal = null;
    let freshMarket = null;
    let freshQuotes = null;
    try {
      // Balance changes much more slowly than the book. Cache this diagnostic
      // refresh to avoid consuming Kalshi REST quota on every IOC attempt.
      if (this._diagnosticBalanceCache && Date.now() - this._diagnosticBalanceAt < 30000) {
        freshBal = this._diagnosticBalanceCache;
      } else {
        const balanceResp = await this.get('/trade-api/v2/portfolio/balance');
        freshBal = parseBalance(balanceResp.data);
        this._diagnosticBalanceCache = freshBal;
        this._diagnosticBalanceAt = Date.now();
        this.state?.updateBalance?.(freshBal);
      }
    } catch (e) {
      console.warn(`[KalshiClient] FRESH BALANCE FETCH FAILED: ${e.message}`);
    }
    try {
      const marketResp = await this.get(`/trade-api/v2/markets/${spec.ticker}`);
      freshMarket = parseMarket(marketResp.data.market);
    } catch (e) {
      console.warn(`[KalshiClient] FRESH MARKET FETCH FAILED: ${e.message}`);
    }
    try {
      const bookResp = await this.get(`/trade-api/v2/markets/${spec.ticker}/orderbook?depth=20`);
      const rawBook = bookResp.data?.orderbook_fp || bookResp.data?.orderbook || bookResp.data;
      freshQuotes = executableQuotes(normalizeSnapshot(rawBook));
    } catch (e) {
      console.warn(`[KalshiClient] FRESH ORDERBOOK FETCH FAILED: ${e.message}`);
    }

    console.log(`[KalshiClient] LIVE ORDER INTENT: ${spec.action.toUpperCase()} ${spec.outcomeSide.toUpperCase()} ${spec.ticker} x${spec.count} @ $${Number(spec.limitPrice).toFixed(4)}`);
    console.log(`[KalshiClient] LIVE ORDER BODY: ${JSON.stringify(body)}`);
    console.log(`[KalshiClient] LOCAL BALANCE: available=$${Number(localBal.available || 0).toFixed(4)} total=$${Number(localBal.total || 0).toFixed(4)} reserved=$${Number(localBal.reserved || 0).toFixed(4)}`);
    if (freshBal) console.log(`[KalshiClient] FRESH KALSHI BALANCE: available=$${Number(freshBal.available || 0).toFixed(4)} total=$${Number(freshBal.total || 0).toFixed(4)} portfolio=$${Number(freshBal.portfolioValue || 0).toFixed(4)}`);
    if (freshMarket) console.log(`[KalshiClient] FRESH MARKET: YES bid/ask=${Number(freshMarket.yesBid).toFixed(4)}/${Number(freshMarket.yesAsk).toFixed(4)} | NO bid/ask=${Number(freshMarket.noBid).toFixed(4)}/${Number(freshMarket.noAsk).toFixed(4)}`);
    if (freshQuotes) {
      const q = x => x ? `$${Number(x.price).toFixed(4)} x${x.quantity}` : 'none';
      console.log(`[KalshiClient] FRESH ORDERBOOK: YES bid=${q(freshQuotes.yesBid)} ask=${q(freshQuotes.yesAsk)} | NO bid=${q(freshQuotes.noBid)} ask=${q(freshQuotes.noAsk)}`);
    }
    // The REST market object directly exposes outcome-side executable asks.
    // Prefer it for the pre-trade check; reconstructed two-sided orderbook views
    // can use legacy complementary pricing depending on the feed representation.
    const executableAsk = spec.outcomeSide === 'yes' ? (freshMarket?.yesAsk ?? freshQuotes?.yesAsk?.price) : (freshMarket?.noAsk ?? freshQuotes?.noAsk?.price);
    if (spec.action === 'buy' && Number.isFinite(Number(executableAsk))) {
      const delta = Number(spec.limitPrice) - Number(executableAsk);
      console.log(`[KalshiClient] EXECUTION CHECK: ${spec.outcomeSide.toUpperCase()} limit=$${Number(spec.limitPrice).toFixed(4)} fresh_ask=$${Number(executableAsk).toFixed(4)} delta=${delta >= 0 ? '+' : ''}${delta.toFixed(4)} ${delta >= -1e-9 ? '(marketable now)' : '(NOT marketable now)'}`);
    }
    const expectedEntryCost = spec.action === 'buy' ? Number(spec.count) * Number(spec.limitPrice) : 0;
    console.log(`[KalshiClient] ROUTING: subaccount=${body.subaccount} exchange_index=${body.exchange_index} | expected entry premium≈$${expectedEntryCost.toFixed(2)} before fees`);
    const resp = await this.post(V2_ORDERS_PATH, body);
    return parseCreateOrderResponse(resp.data, spec);
  }

  async getOrder(orderId) {
    if (this.paper && String(orderId).startsWith('paper-')) return this.paper.get(orderId);
    const resp = await this.get(`/trade-api/v2/portfolio/orders/${orderId}`);
    return parseOrder(resp.data.order);
  }

  async cancelOrder(orderId) {
    if (this.paper && String(orderId).startsWith('paper-')) return this.paper.cancel(orderId);
    const resp = await this.delete(`/trade-api/v2/portfolio/orders/${orderId}`);
    return resp.data;
  }

  /** Called when a market settles so paper cash/holdings stay consistent. No-op in live mode. */
  recordSettlement(ticker, result) {
    return this.paper ? this.paper.settle(ticker, result) : 0;
  }

  // Fetch actual positions from Kalshi (for reconciliation on startup)
  async fetchPositions(seriesTicker) {
    if (this.paper) return [];
    try {
      // Fetch ALL unsettled positions (ticker filter requires exact market ticker, not series)
      const apiPath = `/trade-api/v2/portfolio/positions?settlement_status=unsettled&limit=200`;
      const resp = await this.get(apiPath);
      const all = resp.data.market_positions || [];
      // Filter client-side to our series only
      return all
        .filter(p => p.ticker && p.ticker.startsWith(seriesTicker))
        .map(parsePosition)
        .filter(Boolean);
    } catch (error) {
      console.error('[Kalshi] Failed to fetch positions:', error.message);
      throw error;
    }
  }

  /**
   * Sell (close) an existing position. Immediate-or-cancel + reduce-only: it can
   * only reduce what we hold and never leaves a resting order behind.
   */
  async sellPosition(ticker, side, count, priceCents, { priceDollars } = {}) {
    const orderData = {
      ticker,
      action: 'sell',
      side,
      count,
      type: 'limit',
      time_in_force: 'immediate_or_cancel',
      reduce_only: true,
      client_order_id: `sell-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    };
    const dollars = priceDollars ?? priceCents / 100;
    if (side === 'yes') orderData.yes_price_dollars = formatPrice(dollars);
    else orderData.no_price_dollars = formatPrice(dollars);
    return this.placeOrder(orderData);
  }
}

KalshiClient.V2_ORDERS_PATH = V2_ORDERS_PATH;
KalshiClient.formatCount = formatCount;

module.exports = KalshiClient;
