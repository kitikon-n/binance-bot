import WebSocket from "ws";
import type { Bar } from "../indicators/emaCross.js";

// ราคาใช้ mainnet เสมอ (testnet ราคาเพี้ยน) — order ยังส่งไป BINANCE_BASE_URL ตามเดิม
const MARKET_REST = process.env.BINANCE_MARKET_REST ?? "https://fapi.binance.com";
// kline อยู่ใต้ route /market (URL เดิม /stream ต่อได้แต่ไม่มีข้อมูล)
const MARKET_WS = process.env.BINANCE_MARKET_WS ?? "wss://fstream.binance.com/market";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export const VALID_INTERVALS = Object.keys(INTERVAL_MS);

export function intervalMs(interval: string): number {
  const ms = INTERVAL_MS[interval];
  if (!ms) throw new Error(`Unsupported interval: ${interval}`);
  return ms;
}

// ─── REST: ดึงแท่งที่ปิดแล้ว ─────────────────────────────────

export async function fetchKlines(
  symbol: string,
  interval: string,
  opts: { limit?: number; startTime?: number; endTime?: number } = {}
): Promise<Bar[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(opts.limit ?? 1000),
  });
  if (opts.startTime) params.set("startTime", String(opts.startTime));
  if (opts.endTime) params.set("endTime", String(opts.endTime));

  const res = await fetch(`${MARKET_REST}/fapi/v1/klines?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`klines ${symbol} ${interval}: ${JSON.stringify(data)}`);

  const now = Date.now();
  return (data as any[])
    .map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }))
    .filter((b) => b.closeTime < now); // ตัดแท่งที่ยังไม่ปิด
}

// ─── WebSocket: combined kline stream ────────────────────────

export interface KlineSubscription {
  close(): void;
  readonly connected: boolean;
}

export function subscribeKlines(
  streams: { symbol: string; interval: string }[],
  onClosedBar: (symbol: string, interval: string, bar: Bar) => void,
  log: (msg: string) => void = console.log
): KlineSubscription {
  const names = streams.map((s) => `${s.symbol.toLowerCase()}@kline_${s.interval}`);
  const url = `${MARKET_WS}/stream?streams=${names.join("/")}`;

  let ws: WebSocket | null = null;
  let closed = false;
  let connected = false;
  let retry = 0;
  let watchdog: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  // kline stream ส่งข้อมูลทุก ~250ms ถ้าเงียบเกิน 60s ถือว่าหลุด
  const resetWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      log(`[klines] no data for 60s, reconnecting`);
      ws?.terminate();
    }, 60_000);
  };

  const connect = () => {
    ws = new WebSocket(url);

    ws.on("open", () => {
      connected = true;
      retry = 0;
      log(`[klines] connected ${names.join(", ")}`);
      resetWatchdog();
    });

    ws.on("message", (raw) => {
      resetWatchdog();
      try {
        const msg = JSON.parse(raw.toString());
        const k = msg?.data?.k;
        if (!k || !k.x) return; // สนใจเฉพาะแท่งที่ปิดแล้ว
        onClosedBar(k.s, k.i, {
          openTime: k.t,
          closeTime: k.T,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
        });
      } catch (err) {
        log(`[klines] bad message: ${err}`);
      }
    });

    ws.on("close", () => {
      connected = false;
      if (watchdog) clearTimeout(watchdog);
      if (closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      log(`[klines] disconnected, retry in ${delay}ms`);
      reconnectTimer = setTimeout(connect, delay);
    });

    ws.on("error", (err) => {
      log(`[klines] error: ${err.message}`);
    });
  };

  connect();

  return {
    close() {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.terminate();
    },
    get connected() {
      return connected;
    },
  };
}
