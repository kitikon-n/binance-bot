import crypto from "node:crypto";

const BINANCE_BASE_URL = process.env.BINANCE_BASE_URL!;
const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;

// ─── HMAC SHA256 sign ─────────────────────────────────────────

function sign(queryString: string): string {
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(queryString)
    .digest("hex");
}

// ─── Signed HTTP request ──────────────────────────────────────

async function signedRequest(
  method: "GET" | "POST",
  endpoint: string,
  params: Record<string, string | number> = {}
) {
  const timestamp = Date.now();
  const query = new URLSearchParams({
    ...params,
    timestamp: timestamp.toString(),
    recvWindow: "5000",
  } as Record<string, string>).toString();

  const signature = sign(query);
  const url = `${BINANCE_BASE_URL}${endpoint}?${query}&signature=${signature}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": API_KEY },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Binance API timeout (>10s)");
    }
    throw err;
  }
}

// ─── Public APIs ──────────────────────────────────────────────

export async function getPositions(symbol: string) {
  const positions = await signedRequest("GET", "/fapi/v2/positionRisk", {
    symbol,
  });
  const long = positions.find((p: any) => p.positionSide === "LONG");
  const short = positions.find((p: any) => p.positionSide === "SHORT");
  return {
    longAmt: long ? parseFloat(long.positionAmt) : 0,
    shortAmt: short ? Math.abs(parseFloat(short.positionAmt)) : 0,
  };
}

export async function placeFuturesOrder(
  params: Record<string, string | number>
) {
  return await signedRequest("POST", "/fapi/v1/order", params);
}

export function actionToOrder(action: string) {
  switch (action) {
    case "open_long":
      return { side: "BUY", positionSide: "LONG" };
    case "close_long":
      return { side: "SELL", positionSide: "LONG" };
    case "open_short":
      return { side: "SELL", positionSide: "SHORT" };
    case "close_short":
      return { side: "BUY", positionSide: "SHORT" };
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
