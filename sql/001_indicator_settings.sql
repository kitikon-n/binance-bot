-- EMA Cross indicator settings (1 แถวต่อ strategy)
-- รันใน Supabase SQL Editor ครั้งเดียว

create table if not exists indicator_settings (
  strategy_name   text primary key,  -- = strategies.name
  enabled         boolean      not null default false,
  -- symbol ใช้จาก strategies.symbol
  interval        text         not null default '1m',

  -- ① EMA Cross Engine
  ema_fast        int          not null default 9,
  ema_slow        int          not null default 21,
  ema_src         text         not null default 'close',

  -- ①·5 EMA Slope Filter
  use_slope       boolean      not null default true,
  slope_lookback  int          not null default 3,
  slope_thresh    numeric      not null default 0.05,
  slope_atr_len   int          not null default 14,

  -- ② Volume Confirmation
  use_vol         boolean      not null default true,
  vol_len         int          not null default 20,
  vol_mult        numeric      not null default 1.2,

  -- ③ BTC Leader Bias
  use_htf         boolean      not null default true,
  bias_symbol     text         not null default 'BTCUSDT',
  htf_interval    text         not null default '15m',
  htf_swing_len   int          not null default 10,

  -- ④ SL / TP (fixed RR)
  sl_pct          numeric      not null default 0.4,
  rr1             numeric      not null default 1.5,
  rr2             numeric      not null default 3.0,

  -- ⑤ Close Signal
  use_close_tp1   boolean      not null default true,
  use_close_sl    boolean      not null default true,
  use_close_opp   boolean      not null default true,

  -- ⑥ Signals
  allow_long      boolean      not null default true,
  allow_short     boolean      not null default true,

  updated_at      timestamptz  not null default now()
);
