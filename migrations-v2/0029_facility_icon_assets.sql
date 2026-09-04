-- 0029_facility_icon_assets.sql — 设施图标可由后台上传
--
-- 此前 facility_types.icon_key 只能取 worker/modules/facility-types.ts 里
-- SUPPORTED_ICON_KEYS 那 23 个硬编码值。要加一枚图标得改三处代码：
-- src/lib/facilityIcons.tsx 的 key→lucide 组件表、scripts/generate-tab-icons.mjs
-- 的 key→lucide 名（栅格化成小程序包内 PNG，蓝/白两份），以及那份权威清单本身。
-- 也就是说「加图标」是一次发版，后台自然没有入口。
--
-- 这张表把「key → 图形」从代码搬到库里：管理员上传 SVG，位图落 R2、行落这里，
-- facility_types.icon_key 存 custom-<slug>。icon_key 是自由文本列（只有 ≤50 的
-- 长度约束），所以自定义键直接存得下 —— 不用改 facility_types，也不用改
-- release manifest 的 facilityTypes[].iconKey（本来就是 string | null）。
--
-- 为什么不复用 guide_assets（0022 那张）：它的删除保护只检查「已发布的指南正文
-- 里有没有出现这个键」，设施图标混进去会被判成「没人引用」而删掉，引用它的设施
-- 类型在地图上就变成通用图钉。同 0022 不复用 figure_png 的理由：两种素材的
-- 生命周期规则不同，共用一张表就得靠键名去猜谁在管谁。
--
-- 只 create table，不动任何既有表，也不建触发器 —— 引用完整性由
-- facility-icons.ts 的删除前检查负责（要跨表数一次 facility_types，
-- 触发器写不了这种「先查再拒」还带可读错误码的语义）。

pragma foreign_keys = on;

create table facility_icons (
  id text primary key,
  -- 存进 facility_types.icon_key 的那个值，一律带 custom- 前缀，
  -- 客户端据此判断走内置组件还是去服务端取图。
  icon_key text not null unique,
  -- 后台图标网格里显示的中文名（内置图标那份在 FACILITY_ICON_KEY_LABELS）。
  label text not null,
  media_asset_id text not null references media_assets(id) on delete restrict,
  -- viewBox 等渲染元信息，与 guide_assets.metadata_json 同样的用法。
  metadata_json text not null default '{}' check (json_valid(metadata_json)),
  -- disabled 的图标不再作为新建选项，但已经引用它的类型照常显示。
  status text not null default 'active' check (status in ('active','disabled')),
  created_by text references users(id) on delete set null,
  created_at text not null,
  updated_at text not null
);

create index idx_facility_icons_status on facility_icons(status);
