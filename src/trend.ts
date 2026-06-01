import { supabase } from "./supabase.js";

export async function getMainTrend(symbol: string): Promise<string | null> {
  const { data } = await supabase
    .from("main_trends")
    .select("trend")
    .eq("symbol", symbol)
    .maybeSingle();
  return data?.trend ?? null;
}

export function checkTrendRule(
  action: string,
  trend: string | null
): { allowed: boolean; reason?: string } {
  // ไม่มี trend → อนุญาตเสมอ
  if (trend === null) return { allowed: true };

  const rules: Record<string, string[]> = {
    open_long: ["UP"],
    open_short: ["DOWN"],
    close_long: ["NEUTRAL", "UP"],
    close_short: ["NEUTRAL", "DOWN"],
  };

  const allowedTrends = rules[action];
  if (!allowedTrends) {
    return { allowed: false, reason: `Unknown action: ${action}` };
  }

  if (allowedTrends.includes(trend)) return { allowed: true };

  return {
    allowed: false,
    reason: `${action} not allowed when trend=${trend} (requires: ${allowedTrends.join(
      " or "
    )})`,
  };
}

const VALID_TRENDS = ["UP", "DOWN", "NEUTRAL"];

export async function updateMainTrend(payload: {
  symbol: string;
  trend: string;
  timeframe?: string;
  source?: string;
  raw_payload: any;
}): Promise<{ ok: boolean; error?: string }> {
  const { symbol, trend, timeframe, source, raw_payload } = payload;

  if (!symbol || typeof symbol !== "string") {
    return { ok: false, error: "Invalid symbol" };
  }
  if (!trend || !VALID_TRENDS.includes(trend)) {
    return { ok: false, error: `Invalid trend: ${trend}` };
  }

  const symbolUpper = symbol.toUpperCase();

  // ดึง trend เดิม
  const { data: existing } = await supabase
    .from("main_trends")
    .select("trend")
    .eq("symbol", symbolUpper)
    .maybeSingle();

  const previousTrend = existing?.trend ?? null;

  // Upsert
  const { error: upsertErr } = await supabase.from("main_trends").upsert({
    symbol: symbolUpper,
    trend,
    timeframe: timeframe ?? null,
    source: source ?? null,
    updated_at: new Date().toISOString(),
  });

  if (upsertErr) return { ok: false, error: upsertErr.message };

  // บันทึก history เฉพาะตอน trend เปลี่ยน
  if (previousTrend !== trend) {
    await supabase.from("main_trend_history").insert({
      symbol: symbolUpper,
      trend,
      previous_trend: previousTrend,
      timeframe: timeframe ?? null,
      source: source ?? null,
      raw_payload,
    });
  }

  return { ok: true };
}
