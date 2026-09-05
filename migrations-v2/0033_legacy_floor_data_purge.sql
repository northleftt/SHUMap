-- 0033_legacy_floor_data_purge.sql — 删除楼层旧链路与测试楼层的存量数据
--
-- 0032 把楼内平面图切换成「每层一张图片」时，存量的 floor map_versions 先留在
-- 库里（当时考虑历史 release 的成员记录还引用它们）。2026-09-06 盘查线上库后
-- 确认清掉（见 scripts/audit_legacy_floor_data.mjs 的报告）：
--
--   A. 楼层 SVG 图纸链（钱伟长图书馆的 5 张演示图），按外键方向逆序删：
--      1. location_anchors 解绑：挂在楼层图上的锚点（服务位置等 svg_viewbox 坐标）
--         失去底图后坐标不再有意义，但锚点行本身保留（只置空 map_version_id /
--         map_feature_id），设施与楼层的归属关系不受影响；
--      2. release_map_versions 成员记录：楼层图的发版成员行一并删除 —— 历史
--         release 的权威记录是 R2 里冻结的 manifest 构件，这张 join 表只是簿记；
--      3. map_versions（floor_id 非空）：map_features / map_feature_mappings 随
--         on delete cascade 一并清掉；
--      4. map_assets（floor_svg / floor_image）：floor_image 从未启用过，一并清；
--      5. media_assets（上一步记录的导入源行）：R2 里 private/imports/ 下的 SVG
--         对象 SQL 够不着，成为孤儿对象，用控制台按盘查报告里的键清理；
--      6. jobs 里的 floor_import 任务记录。
--
--   B. 测试楼层：盘查确认 floors 表当时只有 9 行测试数据（1号楼 / A 楼 /
--      本部图书馆 / 钱伟长图书馆），全部删除。floors 被四张表以
--      on delete restrict 引用，先把引用置空再删行；这些引用本来也都指向
--      测试楼层。设施/商户/锚点行本身保留，只是不再属于任何楼层。
--
-- 全部语句幂等：没有存量数据时一行不动。

pragma foreign_keys = on;

create table floor_media_ids as
  select ma.media_asset_id as id
    from map_assets ma
   where ma.asset_type in ('floor_svg','floor_image');

update location_anchors
   set map_version_id = null, map_feature_id = null
 where map_version_id in (select id from map_versions where floor_id is not null)
    or map_feature_id in (select mf.id from map_features mf
                           join map_versions mv on mv.id = mf.map_version_id
                          where mv.floor_id is not null);

delete from release_map_versions
 where map_version_id in (select id from map_versions where floor_id is not null);

delete from map_versions where floor_id is not null;

delete from map_assets where asset_type in ('floor_svg','floor_image');

delete from media_assets where id in (select id from floor_media_ids);

drop table floor_media_ids;

delete from jobs where job_type = 'floor_import';

-- B. 测试楼层：解引用后删行
update facility_instances set floor_id = null where floor_id is not null;
update merchant_outlets set floor_id = null where floor_id is not null;
update location_anchors set floor_id = null where floor_id is not null;
update search_documents set floor_id = null where floor_id is not null;
delete from floors;
