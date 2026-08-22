-- 0024_transit_route_booking.sql — 预约属性上收到线路级
--
-- 校车实际是「校区对校区」的线路，预约/非预约是两条不同的线路（停靠点都不同），
-- 但旧模型把预约语义拆在两处：班次级 transit_trips.booking_policy 和站点级
-- transit_pattern_stops.pickup_type='reservation_only'。前者让同一条线路混排两种
-- 班次，后者让「这个乘车点要不要预约」这种诡异语义存在。
--
-- 本迁移只做三件幂等的小事：
--   1. transit_routes 增加 booking_policy 列，从此线路是预约与否的唯一权威；
--      班次列保留（CHECK 约束重建代价太大），保存时由服务端按线路强制覆盖。
--   2. reservation_only 停用：存量置 regular，不再产出（admin 校验同步收紧）。
--   3. 修数据缺陷：「宝山-西门」站点的 campus_id 此前是 null。
--
-- 线路按预约性拆分（混合班次的路由拆成两条线）由
-- scripts/generate_transit_route_split.mjs 生成的 SQL 完成，不进迁移：
-- 它依赖生产库的当前数据状态，需要先生成、在 dump 副本上验证、再人工应用。

pragma foreign_keys = on;

alter table transit_routes
  add column booking_policy text not null default 'not_required'
  check (booking_policy in ('required','optional','not_required'));

-- 预约入口也跟着线路上收：班次的 booking_url 仍保留作兜底，线路级优先。
alter table transit_routes
  add column booking_url text;

update transit_pattern_stops set pickup_type='regular' where pickup_type='reservation_only';

update transit_stops set campus_id='campus_baoshan'
 where campus_id is null and name='宝山-西门';
