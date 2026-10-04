// แกนกลางของ backtest / optimize — replay klines ผ่าน EmaCrossIndicator ตัวเดียวกับ engine

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { EmaCrossIndicator, HtfBias, type Bar } from "../src/indicators/emaCross.js";
import { fetchKlines, intervalMs } from "../src/market/klines.js";
import type { IndicatorSettingsRow } from "../src/engine.js";

export const WARMUP_BARS = 1000;
const CACHE_DIR = ".cache/klines";

// ─── settings ─────────────────────────────────────────────────

export async function loadStrategy(name: string) {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: row, error } = await db.from("indicator_settings").select("*").eq("strategy_name", name).single();
  if (error || !row) throw new Error(`indicator_settings ไม่พบ ${name}: ${error?.message}`);
  const { data: strat } = await db.from("strategies").select("symbol").eq("name", name).single();
  if (!strat) throw new Error(`strategies ไม่พบ ${name}`);
  return { settings: row as IndicatorSettingsRow, symbol: strat.symbol as string };
}

export function applyOverrides(row: IndicatorSettingsRow, sets: string[]) {
  for (const kv of sets) {
    const [k, v] = kv.split("=");
    if (!(k in row)) throw new Error(`ไม่รู้จัก setting: ${k}`);
    const cur = (row as any)[k];
    (row as any)[k] = typeof cur === "boolean" ? v === "true" : typeof cur === "number" ? Number(v) : v;
  }
}

// ─── data ─────────────────────────────────────────────────────

export async function loadKlines(symbol: string, interval: string, start: number, end: number): Promise<Bar[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const day = 86_400_000;
  const file = `${CACHE_DIR}/${symbol}_${interval}_${Math.floor(start / day)}_${Math.floor(end / day)}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));

  const ms = intervalMs(interval);
  const bars: Bar[] = [];
  let from = start;
  while (from < end) {
    const batch = await fetchKlines(symbol, interval, { startTime: from, endTime: end, limit: 1500 });
    if (!batch.length) break;
    bars.push(...batch);
    from = batch[batch.length - 1].openTime + ms;
  }
  console.log(`  โหลด ${symbol} ${interval}: ${bars.length} แท่ง`);
  writeFileSync(file, JSON.stringify(bars));
  return bars;
}

// ─── simulation ───────────────────────────────────────────────

export interface Trade {
  side: "long" | "short";
  entryTime: number;
  exitTime: number;
  entry: number;
  exitBot: number; // engine ส่ง MARKET ตอนแท่งปิด → ได้ราคา close ของแท่งที่ trigger
  exitIdeal: number; // ถ้ามี SL/TP order บน exchange จริง → ได้ราคาที่ระดับ SL/TP
  reason: string;
  stacked: boolean; // เปิดซ้ำทั้งที่ยังถือฝั่งเดิม (engine ส่ง open ซ้ำ = เพิ่ม position)
}

export function simulate(s: IndicatorSettingsRow, main: Bar[], htf: Bar[], measureFrom: number) {
  const ind = new EmaCrossIndicator(s);
  const bias = new HtfBias(s.htf_swing_len);

  // ค่า bias ของแท่ง HTF ล่าสุดที่ปิดก่อนแท่งหลักเปิด (เหมือน StrategyRunner.biasAt)
  let j = 0;
  let trend = 0;

  const open: Record<"long" | "short", { entry: number; time: number; stacked: boolean }[]> = { long: [], short: [] };
  const trades: Trade[] = [];

  for (const bar of main) {
    if (s.use_htf) {
      while (j < htf.length && htf[j].closeTime < bar.openTime) trend = bias.update(htf[j++]);
    }
    const res = ind.onBar(bar, trend);
    const { long, short } = ind.levels;

    const close = (side: "long" | "short", reason: string) => {
      const lv = side === "long" ? long! : short!;
      const ideal = reason === "tp1" ? lv.tp1 : reason === "sl" || reason === "be" ? lv.sl : bar.close;
      for (const p of open[side]) {
        if (p.time < measureFrom) continue;
        trades.push({
          side,
          entryTime: p.time,
          exitTime: bar.openTime,
          entry: p.entry,
          exitBot: bar.close,
          exitIdeal: ideal,
          reason,
          stacked: p.stacked,
        });
      }
      open[side] = [];
    };

    // ลำดับเดียวกับ engine.dispatch: close ก่อน open
    if (res.closeLong) close("long", res.closeLongReason!);
    if (res.closeShort) close("short", res.closeShortReason!);
    if (res.buy) open.long.push({ entry: bar.close, time: bar.openTime, stacked: open.long.length > 0 });
    if (res.sell) open.short.push({ entry: bar.close, time: bar.openTime, stacked: open.short.length > 0 });
  }
  return trades;
}

// ─── stats ────────────────────────────────────────────────────

export interface Stats {
  n: number;
  winRate: number;
  avgR: number;
  totalR: number;
  totalPct: number;
  pf: number;
  maxDd: number;
}

// ผลเป็นหน่วย R ของ setting นั้น (1R = sl_pct) และ % ต่อ notional (ใช้เทียบข้าม sl_pct)
export function stats(trades: Trade[], slPct: number, fee: number, mode: "bot" | "ideal"): Stats {
  const rs = trades.map((t) => {
    const exit = mode === "bot" ? t.exitBot : t.exitIdeal;
    const dir = t.side === "long" ? 1 : -1;
    const pct = ((exit - t.entry) / t.entry) * 100 * dir - 2 * fee;
    return pct / slPct;
  });
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  let eq = 0, peak = 0, maxDd = 0;
  for (const r of rs) {
    eq += r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return {
    n: rs.length,
    winRate: rs.length ? (wins.length / rs.length) * 100 : 0,
    avgR: rs.length ? sum(rs) / rs.length : 0,
    totalR: sum(rs),
    totalPct: sum(rs) * slPct,
    pf: losses.length ? sum(wins) / Math.abs(sum(losses)) : Infinity,
    maxDd,
  };
}

export const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "∞");
