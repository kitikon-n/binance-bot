-- Breakeven: เลื่อน SL ไปจุดคุ้มทุนเมื่อกำไรถึง X R
-- รันใน Supabase SQL Editor ครั้งเดียว (หลัง 001)

alter table indicator_settings
  add column if not exists use_breakeven  boolean not null default false,
  add column if not exists be_trigger_r   numeric not null default 0.5,
  add column if not exists be_offset_pct  numeric not null default 0.1;
