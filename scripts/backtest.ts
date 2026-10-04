// Backtest ของ EMA Cross indicator — replay klines ย้อนหลังผ่าน EmaCrossIndicator ตัวเดียวกับ engine
//
//   npm run backtest -- --strategy rsi_bnb_v1 --days 90
//   npm run backtest -- --strategy rsi_bnb_v1 --set interval=5m --set sl_pct=0.7
//
// --strategy  โหลด settings จาก indicator_settings (+ symbol จาก strategies)
// --days      ช่วงที่วัดผล (default 90) — ก่อนหน้านั้นมี warm-up อีก 1000 แท่งเหมือน engine
// --fee       ค่าธรรมเนียมต่อข้าง % (default 0.05 = taker)
// --set k=v   override ค่า setting (ใส่ได้หลายครั้ง)
//
// klines cache ไว้ที่ .cache/klines/ (ลบทิ้งถ้าอยากดึงใหม่)

import type { IndicatorSettingsRow } from "../src/engine.js";
import { intervalMs } from "../src/market/klines.js";
import { WARMUP_BARS, applyOverrides, fmt as f, loadKlines, loadStrategy, simulate, stats, type Trade } from "./backtestCore.js";

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { strategy: "", days: 90, fee: 0.05, sets: [] as string[] };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--strategy") out.strategy = a[++i];
    else if (a[i] === "--days") out.days = Number(a[++i]);
    else if (a[i] === "--fee") out.fee = Number(a[++i]);
    else if (a[i] === "--set") out.sets.push(a[++i]);
  }
  if (!out.strategy) throw new Error("ต้องระบุ --strategy <name>");
  return out;
}

function report(trades: Trade[], s: IndicatorSettingsRow, fee: number) {
  const by = (r: string) => trades.filter((t) => t.reason === r).length;
  const tp = by("tp1"), sl = by("sl"), be = by("be"), opp = by("opposite");

  console.log(`\nไม้ทั้งหมด ${trades.length}  (long ${trades.filter((t) => t.side === "long").length} / short ${trades.filter((t) => t.side === "short").length}, เปิดซ้อน ${trades.filter((t) => t.stacked).length})`);
  console.log(`TP1 ${tp} | BE ${be} | SL ${sl} | Opposite ${opp}`);
  console.log(`Win rate แบบหน้า admin (TP/(TP+SL)) = ${f(tp + sl ? (tp / (tp + sl)) * 100 : 0, 1)}%`);

  console.log(`\n${"".padEnd(26)}${"bot fill".padStart(12)}${"ideal fill".padStart(12)}${"ideal, no fee".padStart(15)}`);
  const a = stats(trades, s.sl_pct, fee, "bot"), b = stats(trades, s.sl_pct, fee, "ideal"), c = stats(trades, s.sl_pct, 0, "ideal");
  const row = (label: string, k: keyof typeof a, d = 2, suf = "") =>
    console.log(`${label.padEnd(26)}${(f(a[k], d) + suf).padStart(12)}${(f(b[k], d) + suf).padStart(12)}${(f(c[k], d) + suf).padStart(15)}`);
  row("Win rate (pnl > 0)", "winRate", 1, "%");
  row("Expectancy (R/ไม้)", "avgR", 3);
  row("รวม (R)", "totalR", 1);
  row("รวม (% ต่อ notional)", "totalPct", 2, "%");
  row("Profit factor", "pf", 2);
  row("Max drawdown (R)", "maxDd", 1);

  // แยกรายเดือน (bot fill)
  const months = new Map<string, Trade[]>();
  for (const t of trades) {
    const m = new Date(t.entryTime).toISOString().slice(0, 7);
    months.set(m, [...(months.get(m) ?? []), t]);
  }
  console.log(`\nรายเดือน (bot fill)`);
  for (const [m, ts] of months) {
    const st = stats(ts, s.sl_pct, fee, "bot");
    console.log(`  ${m}  ไม้ ${String(ts.length).padStart(4)}  win ${f(st.winRate, 1).padStart(5)}%  ${f(st.totalR, 1).padStart(7)}R`);
  }
}

async function main() {
  const args = parseArgs();
  const { settings: s, symbol } = await loadStrategy(args.strategy);
  applyOverrides(s, args.sets);

  const mainMs = intervalMs(s.interval);
  const end = Math.floor(Date.now() / mainMs) * mainMs;
  const measureFrom = end - args.days * 86_400_000;
  const start = measureFrom - WARMUP_BARS * mainMs;

  console.log(`Backtest ${args.strategy} ${symbol} ${s.interval}  ${new Date(measureFrom).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}  fee ${args.fee}%/ข้าง`);
  console.log(
    `EMA ${s.ema_fast}/${s.ema_slow} | slope ${s.use_slope ? `${s.slope_lookback}b ≥${s.slope_thresh}ATR` : "off"} | vol ${s.use_vol ? `×${s.vol_mult}` : "off"} | ` +
      `bias ${s.use_htf ? `${s.bias_symbol} ${s.htf_interval} sw${s.htf_swing_len}` : "off"} | SL ${s.sl_pct}% TP1 ${s.rr1}R | ` +
      `BE ${s.use_breakeven ? `${s.be_trigger_r}R→+${s.be_offset_pct}%` : "off"} | opp ${s.use_close_opp ? "on" : "off"}`
  );

  const main = await loadKlines(symbol, s.interval, start, end);
  const htfMs = intervalMs(s.htf_interval);
  const htf = s.use_htf ? await loadKlines(s.bias_symbol, s.htf_interval, start - 500 * htfMs, end) : [];

  report(simulate(s, main, htf, measureFrom), s, args.fee);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
