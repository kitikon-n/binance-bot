// Grid search หา setting ของ EMA Cross — จัดอันดับจากช่วง train แล้ววัดซ้ำบนช่วง test (กัน overfit)
//
//   npm run optimize -- --strategy rsi_bnb_v1 --interval 15m --days 365 --test-days 90
//
// PowerShell ตัด "--" ทิ้งแล้ว npm จะกิน --flag ไปหมด → ใช้รูปแบบนี้แทน (ใช้ได้ทุก shell):
//   npm run optimize rsi_bnb_v1 1h days=1095 test-days=270 min-train=80
//
// ผลทั้งหมดบันทึกที่ .cache/optimize_<strategy>_<interval>.json

import { writeFileSync } from "node:fs";
import type { IndicatorSettingsRow } from "../src/engine.js";
import { intervalMs } from "../src/market/klines.js";
import { WARMUP_BARS, fmt as f, loadKlines, loadStrategy, simulate, stats, type Stats } from "./backtestCore.js";

const GRID = {
  ema: [[5, 13], [9, 21], [12, 26], [21, 50]],
  slope: [null, [3, 0.05], [3, 0.1], [3, 0.2]] as ([number, number] | null)[],
  vol: [null, 1.0, 1.3, 1.6] as (number | null)[],
  // ตัด TF ที่เล็กกว่า interval หลักออกตอนรัน
  htf: [null, ["15m", 2], ["1h", 2], ["1h", 5], ["4h", 2], ["1d", 2]] as ([string, number] | null)[],
  sl_pct: [0.8, 1.2, 1.6, 2.2, 3.0],
  rr1: [1.0, 1.5, 2.0],
  breakeven: [false, true],
  opp: [true, false],
};

function parseArgs() {
  // k=v → --k v
  const a = process.argv.slice(2).flatMap((x) => (!x.startsWith("--") && x.includes("=") ? [`--${x.slice(0, x.indexOf("="))}`, x.slice(x.indexOf("=") + 1)] : [x]));
  const out = { strategy: "", interval: "15m", days: 365, testDays: 90, fee: 0.05, top: 20, minTrain: 100, minTest: 25 };
  const positional: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--strategy") out.strategy = a[++i];
    else if (a[i] === "--interval") out.interval = a[++i];
    else if (a[i] === "--days") out.days = Number(a[++i]);
    else if (a[i] === "--test-days") out.testDays = Number(a[++i]);
    else if (a[i] === "--fee") out.fee = Number(a[++i]);
    else if (a[i] === "--top") out.top = Number(a[++i]);
    else if (a[i] === "--min-train") out.minTrain = Number(a[++i]);
    else if (a[i] === "--min-test") out.minTest = Number(a[++i]);
    else if (a[i].startsWith("--")) throw new Error(`ไม่รู้จัก option: ${a[i]}`);
    else positional.push(a[i]);
  }
  out.strategy ||= positional[0] ?? "";
  if (positional[1]) out.interval = positional[1];
  if (!out.strategy) throw new Error("ต้องระบุ --strategy <name>");
  return out;
}

function* combos(base: IndicatorSettingsRow, interval: string): Generator<IndicatorSettingsRow> {
  const htfs = GRID.htf.filter((h) => !h || intervalMs(h[0]) >= intervalMs(interval));
  for (const [fast, slow] of GRID.ema)
    for (const slope of GRID.slope)
      for (const vol of GRID.vol)
        for (const htf of htfs)
          for (const sl_pct of GRID.sl_pct)
            for (const rr1 of GRID.rr1)
              for (const be of GRID.breakeven)
                for (const opp of GRID.opp)
                  yield {
                    ...base,
                    interval,
                    ema_fast: fast,
                    ema_slow: slow,
                    use_slope: !!slope,
                    slope_lookback: slope?.[0] ?? base.slope_lookback,
                    slope_thresh: slope?.[1] ?? base.slope_thresh,
                    use_vol: vol !== null,
                    vol_mult: vol ?? base.vol_mult,
                    use_htf: !!htf,
                    htf_interval: htf?.[0] ?? base.htf_interval,
                    htf_swing_len: htf?.[1] ?? base.htf_swing_len,
                    sl_pct,
                    rr1,
                    rr2: Math.max(base.rr2, rr1),
                    use_breakeven: be,
                    be_trigger_r: 0.7,
                    use_close_tp1: true,
                    use_close_sl: true,
                    use_close_opp: opp,
                  };
}

const label = (s: IndicatorSettingsRow) =>
  `EMA ${s.ema_fast}/${s.ema_slow} | slope ${s.use_slope ? `${s.slope_lookback}b≥${s.slope_thresh}` : "off"} | ` +
  `vol ${s.use_vol ? `×${s.vol_mult}` : "off"} | bias ${s.use_htf ? `${s.htf_interval} sw${s.htf_swing_len}` : "off"} | ` +
  `SL ${s.sl_pct}% TP1 ${s.rr1}R | BE ${s.use_breakeven ? "on" : "off"} | opp ${s.use_close_opp ? "on" : "off"}`;

async function main() {
  const args = parseArgs();
  const { settings: base, symbol } = await loadStrategy(args.strategy);

  const mainMs = intervalMs(args.interval);
  const end = Math.floor(Date.now() / mainMs) * mainMs;
  const measureFrom = end - args.days * 86_400_000;
  const testFrom = end - args.testDays * 86_400_000;
  const start = measureFrom - WARMUP_BARS * mainMs;

  console.log(`Optimize ${args.strategy} ${symbol} ${args.interval}`);
  console.log(`  train ${new Date(measureFrom).toISOString().slice(0, 10)} → ${new Date(testFrom).toISOString().slice(0, 10)}`);
  console.log(`  test  ${new Date(testFrom).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`);

  const main = await loadKlines(symbol, args.interval, start, end);
  const htfData = new Map<string, any[]>();
  for (const h of GRID.htf) {
    if (!h || htfData.has(h[0])) continue;
    htfData.set(h[0], await loadKlines(base.bias_symbol, h[0], start - 500 * intervalMs(h[0]), end));
  }

  const results: { s: IndicatorSettingsRow; train: Stats; test: Stats; all: Stats }[] = [];
  const t0 = Date.now();
  let i = 0;
  for (const s of combos(base, args.interval)) {
    const trades = simulate(s, main, s.use_htf ? htfData.get(s.htf_interval)! : [], measureFrom);
    const train = trades.filter((t) => t.entryTime < testFrom);
    const test = trades.filter((t) => t.entryTime >= testFrom);
    results.push({
      s,
      train: stats(train, s.sl_pct, args.fee, "bot"),
      test: stats(test, s.sl_pct, args.fee, "bot"),
      all: stats(trades, s.sl_pct, args.fee, "bot"),
    });
    if (++i % 1000 === 0) process.stdout.write(`\r  ${i} combos (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  process.stdout.write(`\r  ${i} combos เสร็จใน ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  writeFileSync(`.cache/optimize_${args.strategy}_${args.interval}.json`, JSON.stringify(results));

  // จัดอันดับจาก train เท่านั้น (PF) — test ไว้ดูว่ารอดนอกช่วงที่ใช้เลือกไหม
  const ranked = results
    .filter((r) => r.train.n >= args.minTrain && r.test.n >= args.minTest)
    .sort((a, b) => b.train.pf - a.train.pf);

  const pos = ranked.filter((r) => r.train.totalPct > 0);
  const both = pos.filter((r) => r.test.totalPct > 0);
  console.log(`\nผ่านเกณฑ์จำนวนไม้ ${ranked.length} | train กำไร ${pos.length} | train+test กำไรทั้งคู่ ${both.length}`);

  const show = (title: string, rows: typeof ranked) => {
    console.log(`\n${title}`);
    console.log(`${"#".padStart(3)}  ${"train: n".padStart(8)} ${"win%".padStart(6)} ${"PF".padStart(5)} ${"Σ%".padStart(7)}   ${"test: n".padStart(7)} ${"win%".padStart(6)} ${"PF".padStart(5)} ${"Σ%".padStart(7)}   setting`);
    rows.slice(0, args.top).forEach((r, k) => {
      const a = r.train, b = r.test;
      console.log(
        `${String(k + 1).padStart(3)}  ${String(a.n).padStart(8)} ${f(a.winRate, 1).padStart(6)} ${f(a.pf).padStart(5)} ${f(a.totalPct, 1).padStart(7)}   ` +
          `${String(b.n).padStart(7)} ${f(b.winRate, 1).padStart(6)} ${f(b.pf).padStart(5)} ${f(b.totalPct, 1).padStart(7)}   ${label(r.s)}`
      );
    });
  };
  show(`Top ${args.top} ตาม PF ช่วง train`, ranked);
  show(`Top ${args.top} ที่ win rate ≥ 50% ทั้ง train และ test`, ranked.filter((r) => r.train.winRate >= 50 && r.test.winRate >= 50));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
