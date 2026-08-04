pragma foreign_keys = on;

-- 楼外地点的四个筛选标签在 0011 里是以 active=0 落库的（当时前台还只画楼宇轮廓，
-- 没有楼外 POI 可显示）。但 0012 的 require_place_active_map_filter_insert 要求
-- 「地点分类必须归属一个启用的标签」，于是后台新建 outdoor_area / service_place /
-- transit_stop / sports_venue 这四类地点时一律被拒：
--
--   Place kind must exist and belong to an active map filter
--
-- 批次 12/13 已经把楼外 POI 的渲染、录入与站点图钉全部打通，这四类地点正是那条
-- 链路的入口，标签必须启用，否则整条链路在第一步就走不通。
--
-- 只启用，不新增成员：每个分类各自已有一条 map_filter_members，启用后仍然是
-- 「一个地点分类恰好归属一个启用标签」，发布校验的 exactly-one 规则照旧成立。
-- 反向的 protect_used_map_filter_deactivation 只拦 active 1→0，这里不受影响。
update map_filter_categories
   set active=1,
       updated_at=datetime('now')
 where id in (
   'map_filter_outdoor',
   'map_filter_service_place',
   'map_filter_transit',
   'map_filter_sports'
 );
