-- 0020_guide_documents.sql — 返校指南：独立的内容模块
--
-- 为什么不复用 campaigns/campaign_items：campaign_items.item_type 的 CHECK 里没有
-- 能承载指南的类型，而 SQLite 改 CHECK 要重建整张表（见 0011 的 751 行）。更根本的是
-- 形状不对 —— campaign_items 是带 content_json 的扁平列表，指南是
-- groups → cards → legs/hotspots/sections 的树，且作为「一整份文档」被撰写、审核、发布。
-- 所以这里照 place_revisions / merchant_revisions 的模式单开两张表，全是新建，不动任何 CHECK。
--
-- 与 SHUMap 其余部分的关系：只共用 users（作者/审核人）与 media_assets（图示素材落 R2）。
-- 不进 release_items —— 指南按自己的 current_revision_id 发布，与地图发版是两条独立的线。
-- 这是有意的取舍：指南一年改一轮，不需要跟地图版本绑在一次原子发布里。

-- 一份指南文档。通常只有一份在用（slug='freshman-transit'），
-- 但按年份留出多份的余地：2026 版可以在 2025 版仍在线时并行撰写。
create table guide_documents (
  id text primary key,
  slug text not null unique,
  title text not null,
  -- draft：从未发布过；published：有 current_revision_id 在线；archived：往年版本，不再对外
  lifecycle_status text not null default 'draft' check (lifecycle_status in ('draft','published','archived')),
  -- 指向已审核通过并发布的那一版。为空表示前台读不到内容（未发布）
  current_revision_id text,
  created_by text references users(id) on delete set null,
  created_at text not null,
  updated_at text not null
);

-- 每一版内容的完整快照。content_json 就是前台渲染层吃的那份数据
-- （meta / campuses / cover / groups / cards），约 40KB，远低于 D1 单行上限。
-- 整份存而不是拆表：指南是被当作一份文档整体审核和回滚的，拆开只会让
-- 「退回上一版」变成一堆需要对齐的行操作。
create table guide_revisions (
  id text primary key,
  document_id text not null references guide_documents(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  editorial_status text not null check (editorial_status in ('draft','in_review','approved','rejected','superseded')),
  title text not null,
  -- 版次标签，如「2025 版 · 电子版」。与 content_json.meta.edition 同源，
  -- 单独存一列是为了列表页不必解析整份 JSON
  edition text,
  -- 编辑写给复核人的说明：这一版改了什么。审核清单里直接显示
  note text,
  content_json text not null default '{}' check (json_valid(content_json)),
  -- 内容指纹：同内容重复存版时用它去重，避免版本列表里堆一串
  -- 指纹相同的版本、回溯时分不清该退到哪一版
  content_hash text not null,
  created_by text references users(id) on delete set null,
  created_at text not null,
  submitted_at text,
  reviewed_by text references users(id) on delete set null,
  reviewed_at text,
  review_note text,
  unique(document_id, revision_no)
);

create index idx_guide_revisions_document on guide_revisions(document_id, revision_no desc);
create index idx_guide_revisions_status on guide_revisions(editorial_status);
create index idx_guide_revisions_hash on guide_revisions(document_id, content_hash);

-- 图示素材（原稿裁出的矢量图与位图快照）。
-- asset_key 是内容里 card.figure 引用的那个键，例如 "route-hongqiao-jiading"。
-- 独立于 map_assets：那张表的 asset_type CHECK 是给校区/楼层地图用的，
-- 指南图示挤进去又要改 CHECK。这里自己一张表，互不干扰。
create table guide_assets (
  id text primary key,
  asset_key text not null unique,
  -- svg 供屏幕与打印（矢量，放大不糊）；png 仅供单卡 PNG 导出内联使用
  asset_kind text not null check (asset_kind in ('figure_svg','figure_png','icon_svg')),
  media_asset_id text not null references media_assets(id) on delete restrict,
  -- 原始像素尺寸等元信息，渲染时用来给 <img> 定宽高、避免布局跳动
  metadata_json text not null default '{}' check (json_valid(metadata_json)),
  created_by text references users(id) on delete set null,
  created_at text not null,
  updated_at text not null
);

create index idx_guide_assets_kind on guide_assets(asset_kind);

-- 发布守卫：只有审核通过的版本能成为线上版本。
-- 写成 SELECT RAISE(...) WHERE cond，不用条件分支表达式 —— 远端
-- wrangler d1 migrations apply 的语句切分器不认它，会在表达式收尾的分号处
-- 提前截断触发器体，报 "incomplete input: SQLITE_ERROR [code: 7500]"。
-- 同理，本文件的注释里也不要写出那个表达式的关键字和收尾分号，切分器
-- 对注释不做豁免，写一次踩一次。触发器的 BEGIN/END 必须大写 —— 远端
-- 切分器只认大写，小写会让它找不到触发器收尾，同样报 incomplete input。
create trigger guide_documents_publish_requires_approval
before update of current_revision_id on guide_documents
for each row
when new.current_revision_id is not null
BEGIN
  select raise(abort, 'guide_documents.current_revision_id must reference an approved revision of the same document')
  where not exists (
    select 1 from guide_revisions
    where id = new.current_revision_id
      and document_id = new.id
      and editorial_status = 'approved'
  );
END;
