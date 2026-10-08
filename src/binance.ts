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
  // รวมทุกแถวของแต่ละฝั่ง เผื่อ Binance คืนหลาย position ต่อ positionSide
  const sumSide = (side: string) =>
    positions
      .filter((p: any) => p.positionSide === side)
      .reduce(
        (acc: number, p: any) => acc + Math.abs(parseFloat(p.positionAmt) || 0),
        0
      );

  return {
    longAmt: sumSide("LONG"),
    shortAmt: sumSide("SHORT"),
  };
}

// ภาพรวมพอร์ต Futures: ยอดรวม (USDT-M) + position ที่เปิดอยู่ทุก symbol
export async function getAccountSummary() {
  const [account, risks] = await Promise.all([
    signedRequest("GET", "/fapi/v2/account"),
    signedRequest("GET", "/fapi/v2/positionRisk"),
  ]);
  const num = (v: any) => parseFloat(v) || 0;

  return {
    walletBalance: num(account.totalWalletBalance),
    unrealizedPnl: num(account.totalUnrealizedProfit),
    marginBalance: num(account.totalMarginBalance),
    availableBalance: num(account.availableBalance),
    positionMargin: num(account.totalPositionInitialMargin),
    orderMargin: num(account.totalOpenOrderInitialMargin),
    maintMargin: num(account.totalMaintMargin),
    assets: (account.assets ?? [])
      .filter((a: any) => num(a.walletBalance) !== 0 || num(a.unrealizedProfit) !== 0)
      .map((a: any) => ({
        asset: a.asset,
        walletBalance: num(a.walletBalance),
        unrealizedPnl: num(a.unrealizedProfit),
        marginBalance: num(a.marginBalance),
        availableBalance: num(a.availableBalance),
      })),
    positions: (risks as any[])
      .filter((p) => num(p.positionAmt) !== 0)
      .map((p) => ({
        symbol: p.symbol,
        positionSide: p.positionSide,
        amount: num(p.positionAmt),
        entryPrice: num(p.entryPrice),
        markPrice: num(p.markPrice),
        liquidationPrice: num(p.liquidationPrice),
        notional: num(p.notional),
        unrealizedPnl: num(p.unRealizedProfit),
        leverage: num(p.leverage),
        marginType: p.marginType,
      })),
    updatedAt: Date.now(),
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
