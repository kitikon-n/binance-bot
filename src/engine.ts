import { supabase } from "./supabase.js";
import { processSignal } from "./processor.js";
import {
  EmaCrossIndicator,
  HtfBias,
  type Bar,
  type EmaCrossResult,
  type EmaCrossSettings,
  type EmaCrossSnapshot,
} from "./indicators/emaCross.js";
import {
  fetchKlines,
  intervalMs,
  subscribeKlines,
  type KlineSubscription,
} from "./market/klines.js";

// ─── Types ────────────────────────────────────────────────────

export interface IndicatorSettingsRow extends EmaCrossSettings {
  strategy_name: string;
  enabled: boolean;
  interval: string;
  bias_symbol: string;
  htf_interval: string;
  htf_swing_len: number;
  updated_at?: string;
}

export interface EngineEvent {
  time: string;
  barTime: number;
  action: string;
  price: number;
  reason?: string;
}

export interface RunnerStatus {
  strategy: string;
  symbol: string;
  interval: string;
  state: "starting" | "running" | "error" | "stopped";
  error: string | null;
  connected: boolean;
  startedAt: string | null;
  indicator: EmaCrossSnapshot | null;
  events: EngineEvent[];
}

const MAIN_BACKFILL = 1000;
const HTF_BACKFILL = 500;
const RETRY_MS = 60_000;

// ─── Runner: 1 ตัวต่อ strategy ────────────────────────────────

class StrategyRunner {
  private ind: EmaCrossIndicator;
  private bias: HtfBias;
  private biasHist: { closeTime: number; trend: number }[] = [];
  private lastMain = 0;
  private lastHtf = 0;
  private sub: KlineSubscription | null = null;
  private chain: Promise<void> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private mainMs: number;
  private htfMs: number;

  state: RunnerStatus["state"] = "starting";
  error: string | null = null;
  startedAt: string | null = null;
  events: EngineEvent[] = [];

  constructor(
    readonly settings: IndicatorSettingsRow,
    readonly symbol: string,
    private readonly secret: string
  ) {
    this.ind = new EmaCrossIndicator(settings);
    this.bias = new HtfBias(settings.htf_swing_len);
    this.mainMs = intervalMs(settings.interval);
    this.htfMs = intervalMs(settings.htf_interval);
  }

  private log(msg: string) {
    console.log(`[engine:${this.settings.strategy_name}] ${msg}`);
  }

  async start() {
    const s = this.settings;
    this.state = "starting";
    try {
      // 1) warm-up: replay history เพื่อสร้าง state เหมือนตอน TradingView โหลดกราฟ
      if (s.use_htf) {
        const htfBars = await fetchKlines(s.bias_symbol, s.htf_interval, { limit: HTF_BACKFILL });
        for (const b of htfBars) this.applyHtf(b);
      }
      const mainBars = await fetchKlines(this.symbol, s.interval, { limit: MAIN_BACKFILL });
      for (const b of mainBars) this.applyMain(b);
      if (this.stopped) return;

      this.log(
        `warm-up done: ${mainBars.length} × ${s.interval}` +
          (s.use_htf ? `, bias ${s.bias_symbol} ${s.htf_interval} = ${this.biasAt(Date.now())}` : "")
      );

      // 2) live stream
      const streams = [{ symbol: this.symbol, interval: s.interval }];
      if (s.use_htf) streams.push({ symbol: s.bias_symbol, interval: s.htf_interval });

      this.sub = subscribeKlines(
        streams,
        (symbol, interval, bar) => {
          // ประมวลผลทีละแท่งตามลำดับ (มี await processSignal / gap fill)
          this.chain = this.chain
            .then(() => this.onLiveBar(symbol, interval, bar))
            .catch((err) => this.log(`bar handler error: ${err}`));
        },
        (msg) => this.log(msg)
      );

      this.state = "running";
      this.error = null;
      this.startedAt = new Date().toISOString();
    } catch (err) {
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.log(`start failed: ${this.error} — retry in ${RETRY_MS / 1000}s`);
      if (!this.stopped) this.retryTimer = setTimeout(() => this.restart(), RETRY_MS);
    }
  }

  private restart() {
    if (this.stopped) return;
    this.ind = new EmaCrossIndicator(this.settings);
    this.bias = new HtfBias(this.settings.htf_swing_len);
    this.biasHist = [];
    this.lastMain = 0;
    this.lastHtf = 0;
    void this.start();
  }

  stop() {
    this.stopped = true;
    this.state = "stopped";
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.sub?.close();
  }

  status(): RunnerStatus {
    return {
      strategy: this.settings.strategy_name,
      symbol: this.symbol,
      interval: this.settings.interval,
      state: this.state,
      error: this.error,
      connected: this.sub?.connected ?? false,
      startedAt: this.startedAt,
      indicator: this.ind.snapshot(),
      events: this.events,
    };
  }

  // ─── bar handling ───────────────────────────────────────────

  private async onLiveBar(symbol: string, interval: string, bar: Bar) {
    if (this.stopped) return;
    const s = this.settings;

    if (symbol === s.bias_symbol && interval === s.htf_interval && s.use_htf) {
      await this.fillGap(s.bias_symbol, s.htf_interval, this.lastHtf, this.htfMs, bar.openTime, (b) =>
        this.applyHtf(b)
      );
      this.applyHtf(bar);
    }

    if (symbol === this.symbol && interval === s.interval) {
      await this.fillGap(this.symbol, s.interval, this.lastMain, this.mainMs, bar.openTime, async (b) => {
        const res = this.applyMain(b);
        if (res) await this.dispatch(b, res);
      });
      const res = this.applyMain(bar);
      if (res) await this.dispatch(bar, res);
    }
  }

  // เติมแท่งที่หายไประหว่าง WS หลุด
  private async fillGap(
    symbol: string,
    interval: string,
    last: number,
    ms: number,
    nextOpen: number,
    apply: (b: Bar) => void | Promise<void>
  ) {
    if (!last || nextOpen <= last + ms) return;
    this.log(`gap ${symbol} ${interval}: ${(nextOpen - last) / ms - 1} bars, backfilling`);
    const bars = await fetchKlines(symbol, interval, {
      startTime: last + ms,
      endTime: nextOpen - 1,
      limit: 1000,
    });
    for (const b of bars) await apply(b);
  }

  private applyHtf(bar: Bar) {
    if (bar.openTime <= this.lastHtf) return;
    this.lastHtf = bar.openTime;
    const trend = this.bias.update(bar);
    this.biasHist.push({ closeTime: bar.closeTime, trend });
    if (this.biasHist.length > 1000) this.biasHist.shift();
  }

  // ค่า bias ของแท่ง HTF ล่าสุดที่ "ปิดก่อน" เวลานี้ (= htfExpr[1] ใน realtime, ไม่ repaint)
  private biasAt(time: number): number {
    for (let i = this.biasHist.length - 1; i >= 0; i--) {
      if (this.biasHist[i].closeTime < time) return this.biasHist[i].trend;
    }
    return 0;
  }

  private applyMain(bar: Bar): EmaCrossResult | null {
    if (bar.openTime <= this.lastMain) return null; // กันแท่งซ้ำ
    this.lastMain = bar.openTime;
    return this.ind.onBar(bar, this.biasAt(bar.openTime));
  }

  // ─── ส่งสัญญาณเข้า processSignal ────────────────────────────

  private async dispatch(bar: Bar, res: EmaCrossResult) {
    const actions: { action: string; reason?: string }[] = [];
    if (res.closeLong) actions.push({ action: "close_long", reason: res.closeLongReason });
    if (res.closeShort) actions.push({ action: "close_short", reason: res.closeShortReason });
    if (res.buy) actions.push({ action: "open_long" });
    if (res.sell) actions.push({ action: "open_short" });
    if (!actions.length) return;

    // แท่งเก่า (เช่นเติมหลัง WS หลุดนาน) → อัปเดต state อย่างเดียว ไม่ส่ง order
    const age = Date.now() - bar.closeTime;
    const stale = age > this.mainMs + 30_000;

    const { long, short } = this.ind.levels;
    for (const { action, reason } of actions) {
      const levels = action.endsWith("long") ? long : short;
      this.pushEvent({
        time: new Date().toISOString(),
        barTime: bar.openTime,
        action,
        price: bar.close,
        reason: stale ? `stale (${Math.round(age / 1000)}s) — not sent` : reason,
      });
      if (stale) {
        this.log(`skip stale ${action} @ ${bar.close} (bar closed ${Math.round(age / 1000)}s ago)`);
        continue;
      }

      this.log(`${action} @ ${bar.close}${reason ? ` (${reason})` : ""}`);
      await processSignal({
        strategy: this.settings.strategy_name,
        secret: this.secret,
        symbol: this.symbol,
        action,
        use_trend_filter: false,
        source: "engine",
        bar_time: new Date(bar.openTime).toISOString(),
        price: bar.close,
        close_reason: reason ?? null,
        levels,
      });
    }
  }

  private pushEvent(e: EngineEvent) {
    this.events.unshift(e);
    if (this.events.length > 50) this.events.pop();
  }
}

// ─── Engine registry ──────────────────────────────────────────

const runners = new Map<string, StrategyRunner>();

async function loadAndStart(strategyName: string) {
  const { data: row, error } = await supabase
    .from("indicator_settings")
    .select("*")
    .eq("strategy_name", strategyName)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || !row.enabled) return;

  const { data: strat, error: stratErr } = await supabase
    .from("strategies")
    .select("name, symbol, webhook_secret")
    .eq("name", strategyName)
    .single();
  if (stratErr || !strat) throw new Error(`Strategy not found: ${strategyName}`);

  const runner = new StrategyRunner(row as IndicatorSettingsRow, strat.symbol, strat.webhook_secret);
  runners.set(strategyName, runner);
  void runner.start();
}

export async function startEngine() {
  const { data, error } = await supabase
    .from("indicator_settings")
    .select("strategy_name")
    .eq("enabled", true);
  if (error) {
    console.error(`[engine] cannot load indicator_settings: ${error.message}`);
    return;
  }
  for (const { strategy_name } of data ?? []) {
    await loadAndStart(strategy_name).catch((err) =>
      console.error(`[engine] start ${strategy_name} failed: ${err}`)
    );
  }
  console.log(`[engine] started ${runners.size} strategy runner(s)`);
}

export async function reloadEngine(strategyName: string) {
  runners.get(strategyName)?.stop();
  runners.delete(strategyName);
  await loadAndStart(strategyName);
  console.log(`[engine] reloaded ${strategyName}`);
}

export function engineStatus(): RunnerStatus[] {
  return [...runners.values()].map((r) => r.status());
}
