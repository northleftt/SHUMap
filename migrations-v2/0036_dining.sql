-- 0036_dining.sql — 就餐：供餐时段表 + 开放安排
--
-- 供餐时段表（dining_meal_periods）：全校统一基准时段，驱动就餐页「当前时段」条与
-- 楼层行灰化。餐别枚举 = breakfast / lunner（午晚餐）/ latenight；一个餐别可有多段
-- （午晚餐 = 11:00–13:00 与 16:40–18:30 两行）。特色餐厅与外部商家不受此表约束，
-- 以商户页营业时间为准。改动即时生效，不进 release。
--
-- 开放安排（dining_schedules + dining_schedule_floors）：「日期范围 × 日型集合 ×
-- 开放楼层清单」。周末/节假日只有部分楼层开放，按清单生效；工作日默认全开，
-- 也可录 weekday 安排作单日例外覆盖（台风/维修等，与校车例外日期同思路）。
-- 适用日型枚举与 0025 的 service_calendars.day_type 一致（工作日/周末/假日/寒假/
-- 暑假），解析时按当天的日型（worker/lib/daytype.ts，校历判定）命中。
-- 开放粒度到楼层（营业单元 = 楼层，档口只是品类标签）；no_breakfast 记「无早餐供应」。
-- 即时生效，不进 release。

pragma foreign_keys = on;

create table dining_meal_periods(
  id text primary key,
  meal text not null check (meal in ('breakfast','lunner','latenight')),
  start_time text not null,
  end_time text not null,
  sort_order integer not null default 0
);

insert into dining_meal_periods(id,meal,start_time,end_time,sort_order) values
  ('dmp_breakfast_1','breakfast','06:30','09:30',10),
  ('dmp_lunner_1','lunner','11:00','13:00',20),
  ('dmp_lunner_2','lunner','16:40','18:30',30),
  ('dmp_latenight_1','latenight','19:30','22:00',40);

create table dining_schedules(
  id text primary key,
  valid_from text not null,
  valid_to text not null,
  day_types text not null,
  created_by text references users(id),
  created_at text not null,
  updated_at text not null
);
create index idx_dining_schedules_range on dining_schedules(valid_from, valid_to);

create table dining_schedule_floors(
  schedule_id text not null references dining_schedules(id) on delete cascade,
  floor_id text not null references floors(id) on delete cascade,
  no_breakfast integer not null default 0,
  primary key (schedule_id, floor_id)
);
