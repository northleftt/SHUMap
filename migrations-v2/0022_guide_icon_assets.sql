-- 0022_guide_icon_assets.sql — 图标位图进素材库
--
-- 为什么要动这张表：图标库原本把位图 base64 内联在 guide_revisions.content_json
-- 里（icon.uri，以及给小程序派生的 icon.png）。实测线上第 9 版内容 753,679 字节，
-- 其中 icons 占 725,673 字节 —— 96%。单看一枚：metro-sh 是 3840×3840 的 PNG，
-- base64 后 595,110 字节，而它在时间轴上只画 15px 高。
--
-- 代价不只是体积。content_json 是「一份文档」，前台每次打开都整份下发，
-- 且每改一个字就存一版新快照（第 4-10 版每版都拖着这 700KB）。图示素材那边
-- 早就走对了路：内容里只留 asset_key，位图落 R2、按 ETag 独立缓存、换图不必
-- 重新发一版内容。图标只是当初漏了这条路。
--
-- 所以这里给 asset_kind 补一个 icon_png，让图标位图和图示位图一样进素材库。
-- 不复用 figure_png：编辑器的图示下拉按 kind 过滤候选，图标位图混进去，
-- 「这张图能不能当图示卡用」就得靠键名去猜。
--
-- SQLite 改 CHECK 必须重建整张表（同 0011 的做法）。guide_assets 没有触发器，
-- 也没有别的表引用它（它自己引用 media_assets / users），所以重建只需
-- 建新表 → 搬数据 → 删旧表 → 改名 → 重建索引。
--
-- 不用 create temporary table：D1 的授权器直接拒（SQLITE_AUTH），
-- 见 scripts/validate_migration_applicability.mjs。这里用的是普通表 + 改名。

pragma foreign_keys = on;

create table guide_assets_v2 (
  id text primary key,
  asset_key text not null unique,
  -- figure_*：图示卡与枢纽指引图的素材（svg 供屏幕与打印，png/jpeg 供小程序）
  -- icon_svg：矢量图标（也可内联在内容里，见 guide-render.js 的 icon.svg）
  -- icon_png：图标位图。内容里只留 asset_key，不再 base64 内联
  asset_kind text not null
    check (asset_kind in ('figure_svg','figure_png','icon_svg','icon_png')),
  media_asset_id text not null references media_assets(id) on delete restrict,
  metadata_json text not null default '{}' check (json_valid(metadata_json)),
  created_by text references users(id) on delete set null,
  created_at text not null,
  updated_at text not null
);

insert into guide_assets_v2(
  id, asset_key, asset_kind, media_asset_id, metadata_json, created_by, created_at, updated_at
)
select id, asset_key, asset_kind, media_asset_id, metadata_json, created_by, created_at, updated_at
  from guide_assets;

drop table guide_assets;

alter table guide_assets_v2 rename to guide_assets;

create index idx_guide_assets_kind on guide_assets(asset_kind);
