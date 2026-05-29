# Binance Bot — TradingView Webhook Handler

Backend สำหรับรับ webhook จาก TradingView แล้วส่งคำสั่งไป Binance Futures (Hedge Mode)

## Endpoints

- `GET /` — Health check
- `POST /webhook/tradingview` — รับ open/close signal
- `POST /webhook/trend` — อัปเดต main trend

## Local Development

```bash
npm install
cp .env.example .env
# แก้ค่าใน .env
npm run dev
```

## Deploy to Railway

ดูคำแนะนำเต็มในคู่มือ
