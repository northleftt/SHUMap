-- 0032_floor_plan_image.sql — 楼内平面图改为「每层一张图片」
--
-- 旧链路（floor_svg SVG 导入 → map_versions/map_features → 客户端按 viewBox 渲染
-- 再叠锚点）脆弱且过度工程化，整体废弃：
--   · floors 直接挂 media_assets 里的一张位图（本迁移加的 image_media_id），
--     上传走管理端直传（PUT /api/admin/floors/:id/image），落 public/media/ 即公开可读；
--   · 存量 floor map_versions 行保留（历史 release 的 manifest 构件还引用它们，
--     发版历史不可改写），但新 release 只选校区图（mv.floor_id is null），
--     楼层图从此不再进 manifest.maps，改由 manifest.floors[].imageUrl 直达客户端；
--   · indoor_spaces 不再能新建（createSpace 端点删除），表与既有引用
--     （facility_instances / merchant_outlets / location_anchors 的 indoor_space_id）
--     原样保留 —— 那些列还有数据，SQLite 删列要重建表，留着不影响新链路。
--
-- 只加列，不动任何既有行：存量楼层的 image_media_id 为 null，客户端按「无图」
-- 处理，等管理端逐层上传。

pragma foreign_keys = on;

alter table floors add column image_media_id text references media_assets(id) on delete restrict;
