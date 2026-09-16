-- 0030_analytics_event_types.sql — 扩充埋点事件类型
--
-- analytics_events 原来只收 map_view / poi_view（0003 建表时的 CHECK）。
-- 后续功能（评分反馈、就餐推荐）需要度量前置：页面浏览、搜索、校车查询、
-- 弹层曝光/关闭都要能落库。SQLite 改不了 CHECK 约束，只能整表重建
-- （同 0011 / 0022 的做法）：建新表 → 搬数据 → 删旧表 → 改名 → 重建索引。
-- 这张表没有触发器，也没有别的表引用它。
--
-- 事件类型口径：
--   map_view       地图页浏览（按校区计一次）
--   poi_view       POI 详情弹层曝光
--   page_view      其它页面浏览，meta.page 区分页面
--   search         地图搜索，meta.q / meta.result_count
--   shuttle_query  校车查询，meta.from / meta.to / meta.date
--   dining_view    就餐页浏览（预留给后续就餐功能，暂无上报端）
--   popup_open     弹层曝光，meta.popup 区分弹层（operation / trip_preview / target_picker 等）
--   popup_close    弹层关闭，meta.popup 同上；POI 弹层的曝光用 poi_view，关闭用 popup_close

pragma foreign_keys = on;

create table analytics_events_v2 (
  id text primary key,
  event_type text not null check (event_type in (
    'map_view','poi_view','page_view','search','shuttle_query','dining_view','popup_open','popup_close'
  )),
  campus text,
  place_id text,
  place_name text,
  metadata_json text not null default '{}' check (json_valid(metadata_json)),
  created_at text not null
);

insert into analytics_events_v2(id, event_type, campus, place_id, place_name, metadata_json, created_at)
select id, event_type, campus, place_id, place_name, metadata_json, created_at
  from analytics_events;

drop table analytics_events;

alter table analytics_events_v2 rename to analytics_events;

create index idx_analytics_events_created on analytics_events(created_at desc);
create index idx_analytics_events_type on analytics_events(event_type, created_at desc);
