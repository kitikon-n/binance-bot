import Fastify from "fastify";
import { processSignal } from "./processor.js";
import { updateMainTrend, updateSmallTrend } from "./trend.js";

const TREND_SECRET = process.env.TREND_WEBHOOK_SECRET!;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const fastify = Fastify({
  logger: {
    level: "info",
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss" },
    },
  },
});

// ─── Health check (ใช้สำหรับ Railway healthcheck) ──────────────

fastify.get("/", async () => ({
  status: "ok",
  service: "binance-bot",
  timestamp: new Date().toISOString(),
}));

fastify.get("/health", async () => ({ ok: true }));

// ─── TradingView webhook: เปิด/ปิด order ───────────────────────

fastify.post("/webhook/tradingview", async (request, reply) => {
  const payload = request.body as any;

  // Validate เร็วๆ
  if (
    !payload?.strategy ||
    !payload?.secret ||
    !payload?.action ||
    !payload?.symbol
  ) {
    return reply
      .code(400)
      .send({ ok: false, error: "Missing required fields" });
  }

  // ทำงานหลังบ้าน (fire-and-forget) — ไม่รอ DB หรือ Binance
  // ใช้ setImmediate เพื่อให้ response ส่งออกไปก่อน
  setImmediate(() => {
    processSignal(payload).catch((err) => {
      request.log.error({ err }, "processSignal failed");
    });
  });

  // ตอบทันที (< 50ms)
  return reply.code(202).send({ ok: true, received: true });
});

// ─── Trend update webhook ─────────────────────────────────────

fastify.post("/webhook/trend", async (request, reply) => {
  const payload = request.body as any;

  // Validate
  if (!payload?.secret || !payload?.symbol || !payload?.trend) {
    return reply
      .code(400)
      .send({ ok: false, error: "Missing required fields" });
  }

  // Verify secret ก่อน (เร็ว ไม่กระทบ response time)
  if (payload.secret !== TREND_SECRET) {
    return reply.code(401).send({ ok: false, error: "Invalid secret" });
  }

  // ทำงานหลังบ้าน
  setImmediate(() => {
    updateMainTrend({
      symbol: payload.symbol,
      trend: payload.trend,
      timeframe: payload.timeframe,
      source: payload.source,
      raw_payload: payload,
    }).catch((err) => {
      request.log.error({ err }, "updateMainTrend failed");
    });
  });

  return reply.code(202).send({ ok: true, received: true });
});

// ─── Small trend update webhook ──────────────────────────────

fastify.post("/webhook/small-trend", async (request, reply) => {
  const payload = request.body as any;

  if (!payload?.secret || !payload?.symbol || !payload?.small_trend) {
    return reply
      .code(400)
      .send({ ok: false, error: "Missing required fields" });
  }

  if (payload.secret !== TREND_SECRET) {
    return reply.code(401).send({ ok: false, error: "Invalid secret" });
  }

  setImmediate(() => {
    updateSmallTrend({
      symbol: payload.symbol,
      small_trend: payload.small_trend,
      timeframe: payload.timeframe,
      source: payload.source,
    }).then((result) => {
      fastify.log.info({ result }, "updateSmallTrend result");
    }).catch((err) => {
      fastify.log.error({ err }, "updateSmallTrend failed");
    });
  });

  return reply.code(202).send({ ok: true, received: true });
});

// ─── Start server ─────────────────────────────────────────────

async function start() {
  try {
    // listen ที่ 0.0.0.0 สำคัญสำหรับ Railway
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
