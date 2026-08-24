-- 0028_operational_event_color.sql — 运营事件标注颜色可选
--
-- 此前地图上的事件标注颜色由 severity 硬编码（info/warning/critical 三色）。
-- 管理端需要自选颜色：加可空 color 列，存 #rrggbb；NULL = 按 severity 默认色，
-- 双端渲染保持「有 color 用 color，否则回落 severity」。

pragma foreign_keys = on;

alter table operational_events add column color text;
