-- 0026_transit_stop_marker_size.sql — 校车站点图钉大小档位
--
-- 管理端需要按站点控制地图图钉大小（小/标准/大）。地点/设施/商户走的是
-- content.marker.size（content 顶层允许多余键，随修订→发布自动进 manifest），
-- 但站点不走修订流、没有 content 载荷，只能落独立列。
--
-- 兼容性：manifest 的 transit.stops 在客户端是 exactObject 白名单校验，多一个键
-- 整份 release 解析失败。已发布的小程序旧版本不认识这个键，所以 worker 装配
-- manifest 时只在非标准档才输出 marker_size（见 worker/modules/releases.ts）——
-- 在管理员真正给某个站点调档并发布之前，旧客户端不受影响。

pragma foreign_keys = on;

alter table transit_stops
  add column marker_size text not null default 'standard'
  check (marker_size in ('small','standard','large'));
