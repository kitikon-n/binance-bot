import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { supabase } from "./supabase.js";
import { engineStatus, reloadEngine } from "./engine.js";
import { VALID_INTERVALS } from "./market/klines.js";

// ค่า default = ค่าเดียวกับ input ใน Pine Script
export const DEFAULT_SETTINGS = {
  enabled: false,
  interval: "1m",
  ema_fast: 9,
  ema_slow: 21,
  ema_src: "close",
  use_slope: true,
  slope_lookback: 3,
  slope_thresh: 0.05,
  slope_atr_len: 14,
  use_vol: true,
  vol_len: 20,
  vol_mult: 1.2,
  use_htf: true,
  bias_symbol: "BTCUSDT",
  htf_interval: "15m",
  htf_swing_len: 10,
  sl_pct: 0.4,
  rr1: 1.5,
  rr2: 3.0,
  use_close_tp1: true,
  use_close_sl: true,
  use_close_opp: true,
  allow_long: true,
  allow_short: true,
};

const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const numb = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
const bool = { type: "boolean" };

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(DEFAULT_SETTINGS),
  properties: {
    enabled: bool,
    interval: { type: "string", enum: VALID_INTERVALS },
    ema_fast: int(1, 500),
    ema_slow: int(1, 500),
    ema_src: { type: "string", enum: ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"] },
    use_slope: bool,
    slope_lookback: int(1, 100),
    slope_thresh: numb(0, 10),
    slope_atr_len: int(1, 500),
    use_vol: bool,
    vol_len: int(1, 500),
    vol_mult: numb(0, 20),
    use_htf: bool,
    bias_symbol: { type: "string", pattern: "^[A-Z0-9]{2,20}$" },
    htf_interval: { type: "string", enum: VALID_INTERVALS },
    htf_swing_len: int(2, 50),
    sl_pct: numb(0.01, 20),
    rr1: numb(0.1, 20),
    rr2: numb(0.1, 20),
    use_close_tp1: bool,
    use_close_sl: bool,
    use_close_opp: bool,
    allow_long: bool,
    allow_short: bool,
  },
};

const ADMIN_HTML = new URL("../public/admin.html", import.meta.url);

export async function adminRoutes(fastify: FastifyInstance) {
  fastify.get("/admin", async (_req, reply) => {
    const html = await readFile(ADMIN_HTML, "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  // รายชื่อ strategy (ไม่ส่ง secret ออกไป)
  fastify.get("/api/strategies", async () => {
    const [{ data: strats, error }, { data: settings }] = await Promise.all([
      supabase.from("strategies").select("name, symbol, enabled").order("name"),
      supabase.from("indicator_settings").select("strategy_name, enabled"),
    ]);
    if (error) throw new Error(error.message);
    const byName = new Map((settings ?? []).map((s) => [s.strategy_name, s.enabled]));
    return (strats ?? []).map((s) => ({
      ...s,
      indicator_configured: byName.has(s.name),
      indicator_enabled: byName.get(s.name) ?? false,
    }));
  });

  fastify.get<{ Params: { strategy: string } }>(
    "/api/indicator-settings/:strategy",
    async (req) => {
      const { data, error } = await supabase
        .from("indicator_settings")
        .select("*")
        .eq("strategy_name", req.params.strategy)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return {
        settings: data ?? { strategy_name: req.params.strategy, ...DEFAULT_SETTINGS },
        defaults: DEFAULT_SETTINGS,
        exists: !!data,
      };
    }
  );

  fastify.put<{ Params: { strategy: string }; Body: typeof DEFAULT_SETTINGS }>(
    "/api/indicator-settings/:strategy",
    { schema: { body: settingsSchema } },
    async (req, reply) => {
      const strategy = req.params.strategy;
      const body = req.body;
      if (body.ema_fast >= body.ema_slow) {
        return reply.code(400).send({ ok: false, error: "Fast EMA ต้องน้อยกว่า Slow EMA" });
      }

      const { data, error } = await supabase
        .from("indicator_settings")
        .upsert(
          { strategy_name: strategy, ...body, updated_at: new Date().toISOString() },
          { onConflict: "strategy_name" }
        )
        .select()
        .single();
      if (error) return reply.code(400).send({ ok: false, error: error.message });

      await reloadEngine(strategy);
      return { ok: true, settings: data };
    }
  );

  fastify.get("/api/engine/status", async () => engineStatus());

  fastify.get<{ Querystring: { strategy?: string } }>("/api/signals/recent", async (req) => {
    let q = supabase
      .from("signals")
      .select("id, received_at, strategy_name, symbol, action, error, raw_payload")
      .order("received_at", { ascending: false })
      .limit(50);
    if (req.query.strategy) q = q.eq("strategy_name", req.query.strategy);
    const { data: signals, error } = await q;
    if (error) throw new Error(error.message);

    const ids = (signals ?? []).map((s) => s.id);
    const { data: trades } = ids.length
      ? await supabase
          .from("trades")
          .select("signal_id, status, quantity, binance_order_id, binance_response")
          .in("signal_id", ids)
      : { data: [] as any[] };
    const tradeBySignal = new Map((trades ?? []).map((t) => [t.signal_id, t]));

    return (signals ?? []).map((s) => {
      const t = tradeBySignal.get(s.id);
      return {
        id: s.id,
        created_at: s.received_at,
        strategy: s.strategy_name,
        symbol: s.symbol,
        action: s.action,
        source: s.raw_payload?.source ?? "tradingview",
        price: s.raw_payload?.price ?? null,
        close_reason: s.raw_payload?.close_reason ?? null,
        status: t?.status ?? (s.error ? "error" : "pending"),
        quantity: t?.quantity ?? null,
        order_id: t?.binance_order_id ?? null,
        reason: t?.binance_response?.reason ?? t?.binance_response?.error ?? s.error ?? null,
      };
    });
  });
}
