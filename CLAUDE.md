# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Dev mode with tsx watch + auto-reload
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled output (production)
```

No test suite exists. Validate changes by running `npm run dev` and sending test webhook payloads.

## Architecture

**Purpose:** Fastify microservice that receives TradingView webhooks and executes Binance Futures orders, with trend-based trade filtering.

**Entry point:** `src/index.ts` — registers webhook routes + admin plugin, starts the server, then calls `startEngine()`.

**Signal sources:** signals reach `processSignal()` either from TradingView webhooks or from the built-in **indicator engine** (`src/engine.ts`), a port of the Pine "EMA Cross Indicator" that streams Binance klines itself (so no paid TradingView plan is needed). Engine signals send `use_trend_filter: false` — its own BTC bias filter replaces the `main_trends` filter.

**Webhook endpoints:**
- `POST /webhook/tradingview` — receives trade signals (open/close long/short)
- `POST /webhook/trend` — updates the current market trend per symbol
- `GET /health` — liveness check
- `GET /` — info
- `GET /admin` — settings UI (`public/admin.html`, **no auth**) + JSON API under `/api/*` (`src/admin.ts`)

**Fire-and-forget pattern:** Both webhook routes respond `202 Accepted` immediately, then delegate to `setImmediate(processSignal)` / `setImmediate(updateMainTrend)` to avoid TradingView's 5-second timeout constraint.

**Core modules:**

| File | Role |
|------|------|
| `src/processor.ts` | Main orchestrator: validates signal → checks trend → places order → logs result |
| `src/binance.ts` | Binance Futures REST client (HMAC-SHA256 signed requests) |
| `src/trend.ts` | Trend read/write logic and rule enforcement |
| `src/supabase.ts` | Supabase client singleton |
| `src/engine.ts` | One `StrategyRunner` per enabled `indicator_settings` row: warm-up replay → live closed bars → `processSignal()`; `reloadEngine()` on settings save |
| `src/indicators/emaCross.ts` | Pine port: EMA cross + slope/ATR + volume + BTC pivot bias (`HtfBias`) + fixed-RR SL/TP close state |
| `src/indicators/ta.ts` | Streaming EMA/SMA/RMA/ATR/pivot matching Pine seeding |
| `src/market/klines.ts` | Binance kline REST backfill + combined WS stream (closed bars only, reconnect + gap fill) |
| `src/admin.ts` | `/admin` page + `/api/strategies`, `/api/indicator-settings/:strategy`, `/api/engine/status`, `/api/signals/recent` |

**Trade flow in `processor.ts`:**
1. Insert raw signal into `signals` table
2. Fetch strategy config from `strategies` table (enabled flag, secret, symbol, quantity)
3. Authenticate signal secret
4. Call `checkTrendRule(action, trend)` — block counter-trend entries
5. If closing: fetch open positions from Binance to determine actual quantity
6. Call `placeFuturesOrder()` — signed POST to Binance API
7. Write outcome to `trades` table (success / failed / skipped / blocked)

**Trend rules** (defined in `src/trend.ts`):
- `open_long` allowed only when trend = `DOWN`
- `open_short` allowed only when trend = `UP`
- `close_long` allowed when trend = `NEUTRAL` or `UP`
- `close_short` allowed when trend = `NEUTRAL` or `DOWN`

## Database (Supabase)

Tables: `signals`, `strategies`, `trades`, `main_trends`, `main_trend_history`, `indicator_settings` (one row per strategy; schema in `sql/001_indicator_settings.sql`, run manually)

Strategies are configured in the DB, not in code. Each strategy has: `name`, `symbol`, `enabled`, `secret`, `quantity`.

## Environment

Copy `.env.example` to `.env` and fill in:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `BINANCE_BASE_URL` (testnet: `https://testnet.binancefuture.com`, mainnet: `https://fapi.binance.com`)
- `BINANCE_API_KEY` / `BINANCE_API_SECRET`
- `TREND_WEBHOOK_SECRET`
- `PORT` (default: 3000)
- `BINANCE_MARKET_REST` / `BINANCE_MARKET_WS` — market data for the engine (default mainnet; WS klines live under `wss://fstream.binance.com/market`)

## Deployment

Configured for Railway via `railway.json` (Nixpacks build, `npm start`, restart on failure up to 10 times).
