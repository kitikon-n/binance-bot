import { Atr, Ema, History, Pivot, Sma } from "./ta.js";

// ─── Types ────────────────────────────────────────────────────

export interface Bar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type EmaSource = "close" | "open" | "high" | "low" | "hl2" | "hlc3" | "ohlc4";

export interface EmaCrossSettings {
  ema_fast: number;
  ema_slow: number;
  ema_src: EmaSource;
  use_slope: boolean;
  slope_lookback: number;
  slope_thresh: number;
  slope_atr_len: number;
  use_vol: boolean;
  vol_len: number;
  vol_mult: number;
  use_htf: boolean;
  sl_pct: number;
  rr1: number;
  rr2: number;
  use_breakeven: boolean;
  be_trigger_r: number;
  be_offset_pct: number;
  use_close_tp1: boolean;
  use_close_sl: boolean;
  use_close_opp: boolean;
  allow_long: boolean;
  allow_short: boolean;
}

export interface Levels {
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  risk: number; // 1R เป็นหน่วยราคา
  be: boolean; // SL ถูกเลื่อนไปจุดคุ้มทุนแล้ว
}

export type CloseReason = "tp1" | "sl" | "be" | "opposite";

export interface EmaCrossResult {
  buy: boolean;
  sell: boolean;
  closeLong: boolean;
  closeShort: boolean;
  closeLongReason?: CloseReason;
  closeShortReason?: CloseReason;
}

export interface EmaCrossSnapshot {
  barTime: number | null;
  close: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  slopeInAtr: number | null;
  slope: "UP" | "DOWN" | "FLAT";
  htfTrend: number;
  volOk: boolean;
  volume: number | null;
  volAvg: number | null;
  inLong: boolean;
  inShort: boolean;
  long: Levels | null;
  short: Levels | null;
  tpCount: number;
  slCount: number;
  beCount: number;
  winRate: number;
}

function src(bar: Bar, s: EmaSource): number {
  switch (s) {
    case "open": return bar.open;
    case "high": return bar.high;
    case "low": return bar.low;
    case "hl2": return (bar.high + bar.low) / 2;
    case "hlc3": return (bar.high + bar.low + bar.close) / 3;
    case "ohlc4": return (bar.open + bar.high + bar.low + bar.close) / 4;
    default: return bar.close;
  }
}

// NaN ใน Pine คือ na → การเปรียบเทียบกับ na ได้ false เสมอ (JS ก็เป็นแบบนั้น)
const num = (v: number) => (Number.isNaN(v) ? null : v);

// ─── ③ BTC Leader Bias (port ของ htfBiasCalc) ─────────────────

export class HtfBias {
  private ph: Pivot;
  private pl: Pivot;
  private up = NaN;
  private dn = NaN;
  private trend = 0;

  constructor(swingLen: number) {
    this.ph = new Pivot(swingLen, "high");
    this.pl = new Pivot(swingLen, "low");
  }

  update(bar: Bar): number {
    const ph = this.ph.update(bar.high);
    const pl = this.pl.update(bar.low);
    if (!Number.isNaN(ph)) this.up = ph;
    if (!Number.isNaN(pl)) this.dn = pl;
    if (!Number.isNaN(this.up) && bar.close > this.up) {
      this.trend = 1;
      this.up = NaN;
    }
    if (!Number.isNaN(this.dn) && bar.close < this.dn) {
      this.trend = -1;
      this.dn = NaN;
    }
    return this.trend;
  }
}

// ─── EMA Cross Indicator ──────────────────────────────────────

export class EmaCrossIndicator {
  private emaFast: Ema;
  private emaSlow: Ema;
  private atr: Atr;
  private volSma: Sma;
  private slowHist: History;
  private prevFast = NaN;
  private prevSlow = NaN;

  private inLong = false;
  private inShort = false;
  private long: Levels | null = null;
  private short: Levels | null = null;
  private tpCount = 0;
  private slCount = 0;
  private beCount = 0;

  private snap: EmaCrossSnapshot;

  constructor(private readonly s: EmaCrossSettings) {
    this.emaFast = new Ema(s.ema_fast);
    this.emaSlow = new Ema(s.ema_slow);
    this.atr = new Atr(s.slope_atr_len);
    this.volSma = new Sma(s.vol_len);
    this.slowHist = new History(s.slope_lookback + 1);
    this.snap = this.buildSnapshot(null, NaN, NaN, NaN, 0, false, NaN);
  }

  // htfTrend: 1 / -1 / 0 (ใช้เฉพาะเมื่อ use_htf)
  onBar(bar: Bar, htfTrend: number): EmaCrossResult {
    const s = this.s;

    // ① EMA cross
    const fast = this.emaFast.update(src(bar, s.ema_src));
    const slow = this.emaSlow.update(src(bar, s.ema_src));
    const crossUp = fast > slow && this.prevFast <= this.prevSlow;
    const crossDn = fast < slow && this.prevFast >= this.prevSlow;
    this.prevFast = fast;
    this.prevSlow = slow;

    // ①·5 slope filter
    const atr = this.atr.update(bar.high, bar.low, bar.close);
    this.slowHist.push(slow);
    const slopeVal = slow - this.slowHist.get(s.slope_lookback);
    const slopeInAtr = atr > 0 ? slopeVal / atr : 0;
    const slopeUp = slopeInAtr >= s.slope_thresh;
    const slopeDn = slopeInAtr <= -s.slope_thresh;
    const slopeLongOk = !s.use_slope || slopeUp;
    const slopeShortOk = !s.use_slope || slopeDn;

    // ② volume
    const volAvg = this.volSma.update(bar.volume);
    const volOk = !s.use_vol || bar.volume > volAvg * s.vol_mult;

    // ③ BTC bias
    const trend = s.use_htf ? htfTrend : 0;
    const htfLongOk = !s.use_htf || trend === 1;
    const htfShortOk = !s.use_htf || trend === -1;

    // SIGNALS
    const buy = crossUp && volOk && htfLongOk && s.allow_long && slopeLongOk;
    const sell = crossDn && volOk && htfShortOk && s.allow_short && slopeShortOk;

    // SIGNAL STATE + LEVELS
    if (buy) {
      const r = (bar.close * s.sl_pct) / 100;
      this.long = { entry: bar.close, sl: bar.close - r, tp1: bar.close + s.rr1 * r, tp2: bar.close + s.rr2 * r, risk: r, be: false };
      this.inLong = true;
    }
    if (sell) {
      const r = (bar.close * s.sl_pct) / 100;
      this.short = { entry: bar.close, sl: bar.close + r, tp1: bar.close - s.rr1 * r, tp2: bar.close - s.rr2 * r, risk: r, be: false };
      this.inShort = true;
    }

    // CLOSE DETECTION
    const L = this.long;
    const cLongTP = s.use_close_tp1 && this.inLong && !buy && !!L && bar.high >= L.tp1;
    const cLongSL = s.use_close_sl && this.inLong && !buy && !!L && bar.low <= L.sl;
    const cLongOpp = s.use_close_opp && this.inLong && sell;
    const closeLong = cLongTP || cLongSL || cLongOpp;
    if (closeLong) this.inLong = false;

    const S = this.short;
    const cShortTP = s.use_close_tp1 && this.inShort && !sell && !!S && bar.low <= S.tp1;
    const cShortSL = s.use_close_sl && this.inShort && !sell && !!S && bar.high >= S.sl;
    const cShortOpp = s.use_close_opp && this.inShort && buy;
    const closeShort = cShortTP || cShortSL || cShortOpp;
    if (closeShort) this.inShort = false;

    // SL ที่ถูกเลื่อนไป breakeven แล้ว → นับเป็น BE ไม่ใช่ SL
    const cLongBE = cLongSL && !!L?.be;
    const cShortBE = cShortSL && !!S?.be;

    if (cLongTP || cShortTP) this.tpCount++;
    if ((cLongSL && !cLongBE) || (cShortSL && !cShortBE)) this.slCount++;
    if (cLongBE || cShortBE) this.beCount++;

    // BREAKEVEN — เช็คหลัง close detection: SL ใหม่มีผลตั้งแต่แท่งถัดไป
    // (ไม่รู้ลำดับ high/low ภายในแท่ง จึงไม่ใช้ SL ใหม่ในแท่งที่ trigger)
    if (s.use_breakeven) {
      if (this.inLong && !buy && L && !L.be && bar.high >= L.entry + s.be_trigger_r * L.risk) {
        L.sl = Math.max(L.sl, L.entry * (1 + s.be_offset_pct / 100));
        L.be = true;
      }
      if (this.inShort && !sell && S && !S.be && bar.low <= S.entry - s.be_trigger_r * S.risk) {
        S.sl = Math.min(S.sl, S.entry * (1 - s.be_offset_pct / 100));
        S.be = true;
      }
    }

    this.snap = this.buildSnapshot(bar, fast, slow, slopeInAtr, trend, volOk, volAvg);

    return {
      buy,
      sell,
      closeLong,
      closeShort,
      closeLongReason: closeLong ? (cLongBE ? "be" : cLongSL ? "sl" : cLongTP ? "tp1" : "opposite") : undefined,
      closeShortReason: closeShort ? (cShortBE ? "be" : cShortSL ? "sl" : cShortTP ? "tp1" : "opposite") : undefined,
    };
  }

  get levels() {
    return { long: this.long, short: this.short };
  }

  snapshot(): EmaCrossSnapshot {
    return this.snap;
  }

  private buildSnapshot(
    bar: Bar | null,
    fast: number,
    slow: number,
    slopeInAtr: number,
    htfTrend: number,
    volOk: boolean,
    volAvg: number
  ): EmaCrossSnapshot {
    const total = this.tpCount + this.slCount;
    return {
      barTime: bar?.openTime ?? null,
      close: bar?.close ?? null,
      emaFast: num(fast),
      emaSlow: num(slow),
      slopeInAtr: num(slopeInAtr),
      slope:
        slopeInAtr >= this.s.slope_thresh ? "UP" : slopeInAtr <= -this.s.slope_thresh ? "DOWN" : "FLAT",
      htfTrend,
      volOk,
      volume: bar?.volume ?? null,
      volAvg: num(volAvg),
      inLong: this.inLong,
      inShort: this.inShort,
      long: this.inLong ? this.long : null,
      short: this.inShort ? this.short : null,
      tpCount: this.tpCount,
      slCount: this.slCount,
      beCount: this.beCount,
      winRate: total > 0 ? (this.tpCount / total) * 100 : 0,
    };
  }
}
