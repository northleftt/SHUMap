-- 0035_academic_calendar.sql — 校历：校园级日型的唯一数据源
--
-- 「今天是什么日型」（工作日/周末/假日/寒假/暑假）此前挂在两处且互不相通：
-- data/academic-calendar.json（手写草稿，worker 零引用）和 service_calendars.day_type
-- （0025 为校车班次归属引入）。校历把这份定义上收为独立的校园级数据：校车服务日历
-- 与就餐开放安排都只是消费者（跟随校历，或单建临时规则覆盖），谁也不依赖谁。
--
-- 判定规则（worker/lib/daytype.ts 的唯一一份算法）完全由这里的数据驱动：
--   调休工作日列表命中 → 工作日；法定节假日命中 → 假日；假期区间命中 → 对应假期；
--   周六日 → 周末；其余 → 工作日。
-- 周末=周六日写死，不随校历配置（国内无变体）。
--
-- 学期结构是自由区间列表：每行 = 名称 + 日型归属 + 起止，可增删（夏季学期、考试周
-- 都能加）。day_type='term' 的行本身不改变日型（周内仍是工作日），主要给消费方提供
-- 学期边界；寒假/暑假行决定对应日型。
--
-- 种子数据就是 data/academic-calendar.json 的 2025-2026 学年——那份手写草稿从此
-- 转正进库，worker 不再依赖仓库里的静态 JSON。

pragma foreign_keys = on;

create table academic_years(
  id text primary key,
  name text not null unique,
  created_at text not null,
  updated_at text not null
);

create table academic_terms(
  id text primary key,
  year_id text not null references academic_years(id) on delete cascade,
  name text not null,
  day_type text not null check (day_type in ('term','winter_break','summer_break')),
  valid_from text not null,
  valid_to text not null,
  sort_order integer not null default 0
);
create index idx_academic_terms_range on academic_terms(valid_from, valid_to);

create table academic_dates(
  id text primary key,
  year_id text not null references academic_years(id) on delete cascade,
  service_date text not null,
  kind text not null check (kind in ('holiday','workday_override')),
  unique(year_id, service_date, kind)
);
create index idx_academic_dates_date on academic_dates(service_date);

insert into academic_years(id,name,created_at,updated_at) values
  ('ay_2025-2026','2025-2026',datetime('now'),datetime('now'));

insert into academic_terms(id,year_id,name,day_type,valid_from,valid_to,sort_order) values
  ('aterm_2526_autumn','ay_2025-2026','秋季学期','term','2025-09-22','2026-01-25',10),
  ('aterm_2526_winter_break','ay_2025-2026','寒假','winter_break','2026-01-26','2026-03-01',20),
  ('aterm_2526_spring','ay_2025-2026','春季学期','term','2026-03-02','2026-08-02',30),
  ('aterm_2526_summer_break','ay_2025-2026','暑假','summer_break','2026-08-03','2026-09-13',40);

insert into academic_dates(id,year_id,service_date,kind) values
  ('ad_2526_h01','ay_2025-2026','2025-10-01','holiday'),
  ('ad_2526_h02','ay_2025-2026','2025-10-02','holiday'),
  ('ad_2526_h03','ay_2025-2026','2025-10-03','holiday'),
  ('ad_2526_h04','ay_2025-2026','2025-10-06','holiday'),
  ('ad_2526_h05','ay_2025-2026','2025-10-07','holiday'),
  ('ad_2526_h06','ay_2025-2026','2025-10-08','holiday'),
  ('ad_2526_h07','ay_2025-2026','2026-01-01','holiday'),
  ('ad_2526_h08','ay_2025-2026','2026-04-06','holiday'),
  ('ad_2526_h09','ay_2025-2026','2026-05-01','holiday'),
  ('ad_2526_h10','ay_2025-2026','2026-05-04','holiday'),
  ('ad_2526_h11','ay_2025-2026','2026-05-05','holiday'),
  ('ad_2526_h12','ay_2025-2026','2026-06-19','holiday'),
  ('ad_2526_o01','ay_2025-2026','2025-09-28','workday_override'),
  ('ad_2526_o02','ay_2025-2026','2025-10-11','workday_override'),
  ('ad_2526_o03','ay_2025-2026','2026-05-09','workday_override');
