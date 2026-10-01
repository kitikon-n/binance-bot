---
name: binance-bot-stack
description: Tooling and workflow guide for the binance-bot repo (Fastify + TypeScript + Supabase + Binance Futures Hedge Mode + Railway, with the built-in EMA Cross indicator engine). Use when setting up, running, debugging, deploying, or changing webhooks, trend filtering, the indicator engine, the admin UI, or the database schema in this project.
---

# binance-bot: stack & workflow

TradingView webhooks (or the built-in indicator engine) → `processSignal()` → Binance USDⓈ-M Futures MARKET order → result logged in Supabase.
Architecture overview lives in `CLAUDE.md`; this skill covers the tools and how to work with them. **When CLAUDE.md and code disagree, trust the code** (see "Gotchas").

Comments/log messages in the codebase are partly Thai — keep that style when editing nearby code.

## Stack at a glance

| Tool | Version | Where / how it's used |
|------|---------|----------------------|
| Node.js | ≥ 20 | ESM (`"type": "module"`) — relative imports **must** end in `.js` (e.g. `./supabase.js`) |
| TypeScript | 5.x | `npm run build` = `tsc` → `dist/`; this is the only type-check |
| tsx | 4.x | `npm run dev` = `tsx watch --env-file=.env src/index.ts` (loads `.env` natively, no dotenv) |
| Fastify | 4.x | HTTP server in `src/index.ts`; admin routes as plugin in `src/admin.ts` (JSON-schema body validation) |
| pino-pretty | 11.x | Fastify logger transport (colorized, `HH:MM:ss`) |
| @supabase/supabase-js | 2.x | Singleton in `src/supabase.ts`, uses **service role key** (bypasses RLS) |
| ws | 8.x | Binance combined kline WebSocket in `src/market/klines.ts` |
| Binance REST | — | No SDK. Native `fetch` + HMAC-SHA256 signing in `src/binance.ts` (`recvWindow=5000`, 10s timeout) |
| Railway | — | `railway.json`: Nixpacks build, `npm start`, restart on failure ×10. Server must listen on `0.0.0.0` |
| TradingView | — | Optional signal source via webhook alerts (engine replaces the need for a paid plan) |

No test framework, no linter, no ORM, no migration tool.

## First-time setup

```bash
npm install
cp .env.example .env     # then fill in values
npm run dev
```

`.env` variables:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `BINANCE_BASE_URL` — **trading** endpoint. Testnet `https://testnet.binancefuture.com` (default, use this first), mainnet `https://fapi.binance.com`
- `BINANCE_API_KEY`, `BINANCE_API_SECRET` — keys for the same network as `BINANCE_BASE_URL`
- `TREND_WEBHOOK_SECRET` — shared secret for `/webhook/trend` and `/webhook/small-trend`
- `PORT` — default 3000 (Railway sets it)
- `BINANCE_MARKET_REST` / `BINANCE_MARKET_WS` — **market data** for the engine; always mainnet even when trading on testnet (`https://fapi.binance.com`, `wss://fstream.binance.com/market`)

Binance account must be in **Hedge Mode** (dual position side) — every order sends `positionSide` LONG/SHORT.

### Database (Supabase SQL Editor, run manually)

`sql/001_indicator_settings.sql` then `sql/002_breakeven.sql` create `indicator_settings`.
The other tables have **no migration file in the repo**. Columns the code uses:

| Table | Columns used by code |
|-------|----------------------|
| `strategies` | `name` (unique), `symbol`, `enabled`, `webhook_secret`, `fixed_quantity` |
| `signals` | `id`, `received_at`, `strategy_name`, `symbol`, `action`, `raw_payload` (jsonb), `processed` (bool), `error` |
| `trades` | `signal_id`, `strategy_name`, `symbol`, `side`, `position_side`, `quantity`, `binance_order_id`, `status` (`success`/`failed`/`skipped`/`blocked`), `binance_response` (jsonb) |
| `main_trends` | `symbol` (unique, upsert key), `trend`, `timeframe`, `source`, `updated_at`, `small_trend`, `small_trend_timeframe`, `small_trend_source`, `small_trend_updated_at` |
| `main_trend_history` | `symbol`, `trend`, `previous_trend`, `timeframe`, `source`, `raw_payload` (jsonb) |
| `indicator_settings` | see `sql/*.sql` (PK `strategy_name` = `strategies.name`) |

If asked to create these, write a new `sql/000_base_tables.sql` (ids as `uuid default gen_random_uuid()`, timestamps `timestamptz default now()`).

## Endpoints

| Method / path | Body | Notes |
|---------------|------|-------|
| `POST /webhook/tradingview` | `strategy, secret, action, symbol` (+ optional `use_trend_filter`) | `action` ∈ `open_long`, `close_long`, `open_short`, `close_short`. Secret checked against `strategies.webhook_secret` |
| `POST /webhook/trend` | `secret, symbol, trend, timeframe?, source?` | `trend` ∈ `UP`/`DOWN`/`NEUTRAL`; history row only when trend changes |
| `POST /webhook/small-trend` | `secret, symbol, small_trend, timeframe?, source?` | Only `update`s an existing `main_trends` row |
| `GET /health`, `GET /` | — | liveness |
| `GET /admin` | — | `public/admin.html` — **no auth** |
| `GET /api/strategies`, `GET\|PUT /api/indicator-settings/:strategy`, `GET /api/engine/status`, `GET /api/signals/recent?strategy=` | — | admin JSON API |

Test payloads:

```bash
curl -X POST localhost:3000/webhook/trend -H 'content-type: application/json' \
  -d '{"secret":"<TREND_WEBHOOK_SECRET>","symbol":"BTCUSDT","trend":"UP","timeframe":"4h"}'

curl -X POST localhost:3000/webhook/small-trend -H 'content-type: application/json' \
  -d '{"secret":"<TREND_WEBHOOK_SECRET>","symbol":"BTCUSDT","small_trend":"UP"}'

curl -X POST localhost:3000/webhook/tradingview -H 'content-type: application/json' \
  -d '{"strategy":"<strategies.name>","secret":"<webhook_secret>","action":"open_long","symbol":"BTCUSDT"}'
```

Webhooks return `202` immediately. Check the outcome in server logs, in `/api/signals/recent`, or in the `trades` table.

## Patterns to preserve

- **Fire-and-forget**: webhook handlers validate the body, reply `202`, and run work in `setImmediate(...)`. This keeps them under TradingView's 5s timeout. Never `await` DB or Binance calls before replying.
- **Signal pipeline** (`src/processor.ts`): insert `signals` → load strategy → check enabled/secret/symbol → trend filter → for closes, read live position size from `/fapi/v2/positionRisk` → `placeFuturesOrder()` MARKET → insert `trades` → mark signal `processed`. Every exit path writes a `trades` row.
- **Closing** uses reduce-by-quantity (the live position amount). Do not use `closePosition=true`: it fails with MARKET orders (error -4136).
- **Action mapping** `actionToOrder()` in `src/binance.ts`: open_long=BUY/LONG, close_long=SELL/LONG, open_short=SELL/SHORT, close_short=BUY/SHORT.
- **Indicator engine** (`src/engine.ts`): one `StrategyRunner` per enabled `indicator_settings` row. It warms up on REST history, then processes only **closed** WS bars, with reconnect and gap fill. It calls `processSignal()` directly with `use_trend_filter: false`, because its own BTC pivot bias (`HtfBias`) is the filter. Stale bars (older than 1 bar + 30s) update state but do not send orders.
- **Settings save**: `PUT /api/indicator-settings/:strategy` validates (fast EMA < slow EMA, breakeven constraints), upserts, then calls `reloadEngine()`.
- **Pine parity**: `src/indicators/ta.ts` (EMA/SMA/RMA/ATR/Pivot) copies TradingView seeding exactly. If you change it, signals will stop matching the Pine "EMA Cross Indicator".

## Common changes

- **New indicator setting**: add `sql/00N_<name>.sql` (`alter table indicator_settings add column if not exists ...`) → add field to `EmaCrossSettings` (`src/indicators/emaCross.ts`) → `DEFAULT_SETTINGS` + `settingsSchema` in `src/admin.ts` → form field in `public/admin.html` → use it in `EmaCrossIndicator`.
- **Trend rules**: the open rules are inline in `processSignal()`, and the close rules are in `checkTrendRule()` (`src/trend.ts`). Update both, and update CLAUDE.md as well.
- **New endpoint**: follow the existing handler shape in `src/index.ts` (validate → 400/401 → `setImmediate` → 202).

## Validation (no test suite)

1. `npm run build` must pass (this is the type check).
2. `npm run dev` against **testnet**, then send the curl payloads above.
3. Check `GET /api/engine/status` (runner state, recent events) and `GET /api/signals/recent`.

## Gotchas / where CLAUDE.md is out of date

- Actual entry rules when `use_trend_filter` is true: `open_long` needs `trend=UP` **and** `small_trend=UP`, and `open_short` needs `DOWN` + `DOWN`. Closes are always allowed. If `trend` is null, `checkTrendRule()` allows everything. (CLAUDE.md's "open_long only when DOWN" is stale.)
- The `strategies` columns are `webhook_secret` / `fixed_quantity`, not `secret` / `quantity`.
- `/webhook/small-trend` is not listed in CLAUDE.md. It only updates a row that `/webhook/trend` has already created.

## Safety

- Never commit `.env` (it is gitignored) or print API keys or the service role key.
- `/admin` and `/api/*` have **no authentication**. Do not share the deployed URL publicly.
- Default to testnet. On mainnet these are real-money orders, so confirm with the user before changing order logic or quantities.
