// ─── Streaming TA primitives ที่ให้ค่าตรงกับ Pine v5 ─────────────
// ทุกตัวรับค่าทีละแท่ง (update) และคืน NaN ระหว่าง warm-up (เทียบ na ใน Pine)

export class Sma {
  private buf: number[] = [];
  private sum = 0;
  constructor(private readonly len: number) {}

  update(v: number): number {
    this.buf.push(v);
    this.sum += v;
    if (this.buf.length > this.len) this.sum -= this.buf.shift()!;
    return this.buf.length === this.len ? this.sum / this.len : NaN;
  }
}

// ta.ema: seed ด้วย SMA ของ len ค่าแรก แล้ว alpha = 2/(len+1)
export class Ema {
  private seed: Sma;
  private value = NaN;
  private readonly alpha: number;
  constructor(len: number) {
    this.seed = new Sma(len);
    this.alpha = 2 / (len + 1);
  }

  update(v: number): number {
    if (Number.isNaN(this.value)) {
      this.value = this.seed.update(v);
    } else {
      this.value = this.alpha * v + (1 - this.alpha) * this.value;
    }
    return this.value;
  }
}

// ta.rma (Wilder): seed ด้วย SMA แล้ว alpha = 1/len
export class Rma {
  private seed: Sma;
  private value = NaN;
  constructor(private readonly len: number) {
    this.seed = new Sma(len);
  }

  update(v: number): number {
    if (Number.isNaN(this.value)) {
      this.value = this.seed.update(v);
    } else {
      this.value = (v + (this.len - 1) * this.value) / this.len;
    }
    return this.value;
  }
}

// ta.atr = rma(ta.tr(true), len) — แท่งแรกใช้ high-low
export class Atr {
  private rma: Rma;
  private prevClose = NaN;
  constructor(len: number) {
    this.rma = new Rma(len);
  }

  update(high: number, low: number, close: number): number {
    const tr = Number.isNaN(this.prevClose)
      ? high - low
      : Math.max(
          high - low,
          Math.abs(high - this.prevClose),
          Math.abs(low - this.prevClose)
        );
    this.prevClose = close;
    return this.rma.update(tr);
  }
}

// ta.pivothigh / ta.pivotlow (left = right = len)
// คืนค่า pivot เมื่อยืนยันแล้ว (ช้าไป len แท่ง) ไม่งั้นคืน NaN
export class Pivot {
  private buf: number[] = [];
  constructor(
    private readonly len: number,
    private readonly kind: "high" | "low"
  ) {}

  update(v: number): number {
    this.buf.push(v);
    const size = this.len * 2 + 1;
    if (this.buf.length > size) this.buf.shift();
    if (this.buf.length < size) return NaN;

    const center = this.buf[this.len];
    for (let i = 0; i < size; i++) {
      if (i === this.len) continue;
      const other = this.buf[i];
      if (this.kind === "high" ? other >= center : other <= center) return NaN;
    }
    return center;
  }
}

// เก็บค่าย้อนหลังเพื่อใช้ series[n]
export class History {
  private buf: number[] = [];
  constructor(private readonly max: number) {}

  push(v: number) {
    this.buf.push(v);
    if (this.buf.length > this.max) this.buf.shift();
  }

  // ago=0 คือค่าล่าสุด
  get(ago: number): number {
    const idx = this.buf.length - 1 - ago;
    return idx >= 0 ? this.buf[idx] : NaN;
  }
}
