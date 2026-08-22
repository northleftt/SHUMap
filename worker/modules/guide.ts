/**
 * guide.ts — 返校指南模块（内容 + 图示素材，自带一套通道）
 *
 * 与 SHUMap 其余部分的关系：只共用 users（作者/审核人）、media_assets（素材落 R2）
 * 和会话/权限体系。内容不进 release_items —— 指南按自己的 current_revision_id 发布。
 *
 * 一份指南是「一整份文档」：撰写、送审、发布、回滚都以整份为单位，
 * 所以 guide_revisions.content_json 存的是渲染层直接吃的那份完整数据，
 * 而不是拆成 groups/cards 多张表。回滚因此只是把 current_revision_id 指回去。
 *
 * 素材通道为什么不复用 POST /api/admin/media：那条通道的类型白名单里
 * 没有 SVG（注释写明「svg 会带脚本，永不放行」），而指南图示的价值就在于矢量
 * —— 原稿的线路、标注、文字放大不糊。所以这里自建通道，代价是必须自己做
 * 消毒：上传时按拒绝式校验（不是剥离，剥离容易漏），读取时再加 CSP sandbox。
 */
import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readBodyLimited, readJsonLimited } from "../lib/http";
import {
  isoNow,
  jsonString,
  makeId,
  objectValue,
  oneOf,
  optionalString,
  parseJsonObject,
  requiredString,
  sha256,
} from "../lib/values";
import { audit } from "./audit";

/** 指南对象在 R2 里的前缀。与 public/media/ 分开，便于单独盘点与清理。 */
const GUIDE_ASSET_PREFIX = "public/guide-assets/";

/** 一份内容的上限。当前 21 页约 45KB，留足到全部补录完（含热区）之后的余量。 */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/** 单张图示上限。原稿裁出的矢量图最大约 1.3MB（87% 是原稿置入的位图底图）。 */
const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/**
 * icon_png 是图标库的位图通道（见 0022）。图标本来把位图 base64 内联在
 * content_json 里，一枚 3840px 的地铁标就占 595KB —— 整份内容 96% 的体积，
 * 而它只画 15px。改成和图示一样按 asset_key 引用后，内容回到 30KB 量级，
 * 位图走素材端点（ETag + 独立缓存），换图也不必重新发一版内容。
 *
 * 单独一种 kind 而不是复用 figure_png：编辑器的图示下拉按 kind 过滤，
 * 图标位图混进去会让「这张图能不能当图示卡」变得要靠键名去猜。
 */
const ASSET_KINDS = ["figure_svg", "figure_png", "icon_svg", "icon_png"] as const;

const ASSET_CONTENT_TYPE: Record<(typeof ASSET_KINDS)[number], string> = {
  figure_svg: "image/svg+xml",
  figure_png: "image/png",
  icon_svg: "image/svg+xml",
  icon_png: "image/png",
};

/** asset_key 会出现在 URL 里，也会被内容用 card.figure 引用，所以限制成安全字符集。 */
const ASSET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// SVG 消毒
// ---------------------------------------------------------------------------

/**
 * 拒绝式校验，不做剥离。
 *
 * 为什么拒绝而不是剥离：剥离要枚举所有危险构造并正确改写，漏一个就等于放行；
 * 拒绝只要求「命中任一危险构造就整份不收」，且能给上传者明确反馈去改源文件。
 * 指南图示由我们自己从原稿导出，本来就不该含脚本 —— 命中即说明导出流程有问题。
 *
 * 覆盖的构造（都在真实 SVG XSS 里出现过）：
 *   <script>            直接执行
 *   on* 属性            onload/onclick/onbegin…
 *   javascript: / data: 在 href/xlink:href 里执行或注入
 *   <foreignObject>     嵌 HTML，可带 <script>
 *   <iframe/embed/object>  嵌外部文档
 *   <use href="外部">    引用外部文档的片段
 *   <!ENTITY>           XXE / 十亿笑声
 *   <handler>/<set attributeName="on…">  SMIL 事件
 */
function assertSafeSvg(text: string): void {
  const lower = text.toLowerCase();

  // 先剥掉注释再查：<!-- <script> --> 是无害的，但注释里藏 ENTITY 不是。
  // 所以 ENTITY 与 DOCTYPE 在剥注释之前查。
  if (/<!doctype/.test(lower) || /<!entity/.test(lower)) {
    throw new HttpError(
      400,
      "unsafe_svg",
      "SVG must not declare a DOCTYPE or entities (XXE risk). Export without a DTD.",
    );
  }

  const stripped = lower.replace(/<!--[\s\S]*?-->/g, "");

  const checks: Array<[RegExp, string]> = [
    [/<script[\s>]/, "contains <script>"],
    [/<iframe[\s>]/, "contains <iframe>"],
    [/<embed[\s>]/, "contains <embed>"],
    [/<object[\s>]/, "contains <object>"],
    [/<foreignobject[\s>]/, "contains <foreignObject>"],
    [/<handler[\s>]/, "contains SMIL <handler>"],
    // on* 事件属性：要求前面是空白，避免误伤 font-variant 之类含 "on" 的属性名
    [/\son[a-z]+\s*=/, "contains an on* event attribute"],
    [/javascript\s*:/, "contains a javascript: URL"],
    // <set attributeName="onload" …>
    [/attributename\s*=\s*["']?\s*on[a-z]/, "targets an event attribute via SMIL"],
  ];

  for (const [pattern, reason] of checks) {
    if (pattern.test(stripped)) {
      throw new HttpError(400, "unsafe_svg", `SVG rejected: ${reason}. Re-export the figure without scripting.`);
    }
  }

  /* href 逐个查。三类判定：
   *
   *   data:image/png|jpeg|gif|webp  放行 —— 原稿图示的路网底图就是这样内嵌的
   *     （<image xlink:href="data:image/png;base64,…">，一张图占其 87% 体积）。
   *     位图不可执行，内嵌反而比外链安全：不产生任何出站请求。
   *   其它 data:                    拒绝 —— 尤其 text/html 与 image/svg+xml，
   *     前者可导航到脚本，后者是能带脚本的嵌套 SVG。
   *   //host 或 scheme://           拒绝 —— 外部文档引用，会泄露访问者 IP，
   *     且目标内容不在我们控制下。
   *
   * 允许 #fragment 与同源相对路径：clipPath/mask/use 靠 #id 互相引用，
   * 拦掉的话原稿图形直接散架。
   */
  const RASTER_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp)\s*;\s*base64\s*,/;
  const hrefs = stripped.match(/(?:xlink:)?href\s*=\s*["'][^"']*["']/g) ?? [];
  for (const raw of hrefs) {
    const value = raw.slice(raw.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "").trim();
    if (/^data:/.test(value)) {
      if (!RASTER_DATA_URI.test(value)) {
        throw new HttpError(
          400,
          "unsafe_svg",
          "SVG rejected: only base64 raster data URIs (png/jpeg/gif/webp) may be embedded; " +
          "text/html and nested image/svg+xml are not allowed.",
        );
      }
      continue;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//.test(value)) {
      throw new HttpError(
        400,
        "unsafe_svg",
        "SVG rejected: references an external document. Embed the artwork instead of linking to it.",
      );
    }
  }

  if (!/<svg[\s>]/.test(stripped)) {
    throw new HttpError(400, "validation_error", "Body does not look like an SVG document");
  }
}

/** 位图魔术字节嗅探：PNG 或 JPEG（实景照片天然是 JPEG，没必要强迫上传者转码）。 */
function sniffRasterType(bytes: ArrayBuffer): "image/png" | "image/jpeg" {
  const view = new Uint8Array(bytes);
  const isPng =
    view.length >= 8 &&
    view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47 &&
    view[4] === 0x0d && view[5] === 0x0a && view[6] === 0x1a && view[7] === 0x0a;
  if (isPng) return "image/png";
  const isJpeg = view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
  if (isJpeg) return "image/jpeg";
  throw new HttpError(415, "unsupported_media_type", "Body is not a PNG or JPEG file");
}

// ---------------------------------------------------------------------------
// 公共读端：GET /api/public/guide/:slug
// ---------------------------------------------------------------------------

/**
 * 前台读已发布内容。只认 current_revision_id 且该版必须 approved ——
 * 草稿与待审内容永远不会从公共侧漏出去。
 *
 * 带 ETag：内容一年改一轮，绝大多数请求应该走 304。
 */
export async function getPublicGuide(request: Request, env: Env, slug: string): Promise<Response> {
  const row = await first<{
    documentId: string;
    slug: string;
    title: string;
    revisionId: string;
    revisionNo: number;
    edition: string | null;
    contentJson: string;
    contentHash: string;
    publishedAt: string;
  }>(
    env.DB,
    `select d.id as documentId,d.slug,r.title,r.id as revisionId,r.revision_no as revisionNo,r.edition,
            r.content_json as contentJson,r.content_hash as contentHash,d.updated_at as publishedAt
       from guide_documents d
       join guide_revisions r on r.id=d.current_revision_id
      where d.slug=? and d.lifecycle_status='published' and r.editorial_status='approved'`,
    [slug],
  );
  if (!row) throw new HttpError(404, "not_found", "Published guide does not exist");

  const etag = `"${row.contentHash}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "public, max-age=300" } });
  }

  return json(
    {
      slug: row.slug,
      title: row.title,
      edition: row.edition,
      revisionId: row.revisionId,
      revisionNo: row.revisionNo,
      publishedAt: row.publishedAt,
      content: parseJsonObject(row.contentJson, "guide content"),
    },
    { headers: { etag, "cache-control": "public, max-age=300" } },
  );
}

/**
 * GET /api/public/guide-assets/:key — 服务图示素材。
 *
 * 三重防线叠在消毒之上：`content-security-policy: sandbox` 让浏览器把它当
 * 无脚本文档处理，`x-content-type-options: nosniff` 阻止类型嗅探，
 * `content-disposition: inline` 不触发下载。按 asset_key 寻址，换图走
 * must-revalidate + ETag（见下），不能 immutable。
 * 读端放行 svg / png / jpeg：figure_png 通道按魔术字节入库，JPEG 是实景照的自然格式。
 */
export async function getPublicGuideAsset(request: Request, env: Env, key: string): Promise<Response> {
  if (!ASSET_KEY_PATTERN.test(key)) throw new HttpError(404, "not_found", "Guide asset does not exist");
  const row = await first<{ objectKey: string; contentType: string; byteSize: number; sha256: string; status: string }>(
    env.DB,
    `select m.object_key as objectKey,m.content_type as contentType,m.byte_size as byteSize,m.sha256,m.status
       from guide_assets a join media_assets m on m.id=a.media_asset_id
      where a.asset_key=? and m.bucket_scope='public'`,
    [key],
  );
  if (!row || row.status !== "published" || !row.objectKey.startsWith(GUIDE_ASSET_PREFIX)) {
    throw new HttpError(404, "not_found", "Guide asset does not exist");
  }
  if (row.contentType !== "image/svg+xml" && row.contentType !== "image/png" && row.contentType !== "image/jpeg") {
    throw new Error(`Guide asset ${key} has unsupported stored content type ${row.contentType}`);
  }
  /* 这个 URL 按 asset_key 寻址，而同一个键的图是会被替换的（换图后引用它的
     卡片自动跟着换，这正是按键寻址的目的）。所以不能用 immutable —— 那会让
     浏览器在一年内都不再回源，后台换了图而用户看到的还是旧图，且无法通过
     刷新解决。改成 must-revalidate + ETag：每次都问一句，没变则 304，
     字节量与 immutable 相当，但换图后立刻生效。 */
  const etag = `"${row.sha256}"`;
  const ifNoneMatch = request.headers.get("if-none-match");
  const cacheControl = "public, max-age=0, must-revalidate";
  const securityHeaders = {
    "content-disposition": "inline",
    "cache-control": cacheControl,
    etag,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  /* If-None-Match 可以带多个值，也可能带 W/ 前缀，逐个比对而不是整串相等 */
  if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers: securityHeaders });
  }

  const object = await env.SHUMAP_BUCKET.get(row.objectKey);
  if (!object) throw new HttpError(404, "not_found", "Guide asset object is missing");
  if (object.size !== row.byteSize) {
    throw new Error(`Guide asset ${key} object size ${object.size} does not match stored ${row.byteSize}`);
  }
  return new Response(object.body, {
    headers: {
      ...securityHeaders,
      "content-type": row.contentType,
      "content-length": String(object.size),
    },
  });
}

// ---------------------------------------------------------------------------
// 管理端：文档与修订
// ---------------------------------------------------------------------------

export async function listGuideDocuments(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select d.id,d.slug,d.title,d.lifecycle_status as lifecycleStatus,d.current_revision_id as currentRevisionId,
            d.created_at as createdAt,d.updated_at as updatedAt,
            cur.revision_no as publishedRevisionNo,cur.edition as publishedEdition,
            (select count(*) from guide_revisions r where r.document_id=d.id) as revisionCount,
            (select count(*) from guide_revisions r where r.document_id=d.id and r.editorial_status in ('draft','in_review')) as openCount
       from guide_documents d
       left join guide_revisions cur on cur.id=d.current_revision_id
      order by d.updated_at desc`,
  );
  return json({ items });
}

/**
 * 一份文档的全貌：文档行 + 修订列表（不含 content_json，列表页不需要几十 KB 的正文）
 * + 当前正在编辑的那一版的完整内容。
 *
 * 「正在编辑的那一版」的选取规则与 places/merchants 一致：优先 in_review，
 * 其次最新的 draft，都没有就退回已发布版 —— 打开编辑器时看到的应该是
 * 「我上次没写完的那份」，而不是线上那份。
 */
export async function getGuideDocument(env: Env, id: string): Promise<Response> {
  const document = await first<Record<string, unknown>>(
    env.DB,
    `select id,slug,title,lifecycle_status as lifecycleStatus,current_revision_id as currentRevisionId,
            created_by as createdBy,created_at as createdAt,updated_at as updatedAt
       from guide_documents where id=?`,
    [id],
  );
  if (!document) throw new HttpError(404, "not_found", "Guide document does not exist");

  const revisions = await all(
    env.DB,
    `select r.id,r.revision_no as revisionNo,r.editorial_status as editorialStatus,r.title,r.edition,r.note,
            r.content_hash as contentHash,r.created_by as createdBy,r.created_at as createdAt,
            r.submitted_at as submittedAt,r.reviewed_by as reviewedBy,r.reviewed_at as reviewedAt,
            r.review_note as reviewNote,length(r.content_json) as contentBytes,
            author.display_name as authorName,reviewer.display_name as reviewerName
       from guide_revisions r
       left join users author on author.id=r.created_by
       left join users reviewer on reviewer.id=r.reviewed_by
      where r.document_id=? order by r.revision_no desc`,
    [id],
  );

  const working = await first<{ id: string; contentJson: string; revisionNo: number; editorialStatus: string }>(
    env.DB,
    `select id,content_json as contentJson,revision_no as revisionNo,editorial_status as editorialStatus
       from guide_revisions
      where document_id=? and editorial_status in ('draft','in_review')
      order by case editorial_status when 'in_review' then 0 else 1 end,revision_no desc limit 1`,
    [id],
  );
  const fallbackId = document.currentRevisionId as string | null;
  const active = working
    ? working
    : fallbackId
      ? await first<{ id: string; contentJson: string; revisionNo: number; editorialStatus: string }>(
          env.DB,
          "select id,content_json as contentJson,revision_no as revisionNo,editorial_status as editorialStatus from guide_revisions where id=?",
          [fallbackId],
        )
      : null;

  return json({
    document,
    revisions,
    working: active
      ? {
          id: active.id,
          revisionNo: active.revisionNo,
          editorialStatus: active.editorialStatus,
          content: parseJsonObject(active.contentJson, "guide content"),
        }
      : null,
  });
}

/** 单独取某一版的正文，供版本对比与回滚预览。 */
export async function getGuideRevision(env: Env, revisionId: string): Promise<Response> {
  const row = await first<{
    id: string; documentId: string; revisionNo: number; editorialStatus: string;
    title: string; edition: string | null; note: string | null; contentJson: string; contentHash: string;
  }>(
    env.DB,
    `select id,document_id as documentId,revision_no as revisionNo,editorial_status as editorialStatus,
            title,edition,note,content_json as contentJson,content_hash as contentHash
       from guide_revisions where id=?`,
    [revisionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Guide revision does not exist");
  const { contentJson, ...meta } = row;
  return json({ revision: { ...meta, content: parseJsonObject(contentJson, "guide content") } });
}

/**
 * 空壳内容（schema v2）：新建文档时如果没带 content，用它占位。
 *
 * 必须满足 assertContentShape 的契约（cards 数组 + hubs 数组），否则
 * 新建出来的文档一存就被自己的校验拒掉。每次调用返回新对象而不是共享常量 ——
 * 后续会被 JSON 序列化写库，共享可变对象是自找麻烦。
 */
function EMPTY_CONTENT(): Record<string, unknown> {
  return {
    schema: 2,
    meta: { title: "", subtitle: "", edition: "" },
    campuses: [],
    hubs: [],
    cards: [],
  };
}

/** 内容的最小契约（schema v2）：渲染层至少需要 cards 与 hubs 才画得出东西。 */
function assertContentShape(content: Record<string, unknown>): void {
  if (!Array.isArray(content.cards)) {
    throw new HttpError(400, "validation_error", "content.cards must be an array");
  }
  if (!Array.isArray(content.hubs)) {
    throw new HttpError(400, "validation_error", "content.hubs must be an array");
  }
}

interface RevisionInput {
  title: string;
  edition: string | null;
  note: string | null;
  content: Record<string, unknown>;
}

async function readRevisionInput(request: Request): Promise<RevisionInput> {
  const body = await readJsonLimited<Record<string, unknown>>(request, MAX_CONTENT_BYTES);
  const content = objectValue(body.content, "content");
  assertContentShape(content);
  return {
    title: requiredString(body.title, "title", 200),
    edition: optionalString(body.edition, "edition", 100),
    note: optionalString(body.note, "note", 2_000),
    content,
  };
}

export async function createGuideDocument(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJsonLimited<Record<string, unknown>>(request, MAX_CONTENT_BYTES);
  const slug = requiredString(body.slug, "slug", 64);
  if (!ASSET_KEY_PATTERN.test(slug)) {
    throw new HttpError(400, "validation_error", "slug must be lowercase letters, digits and dashes");
  }
  /* content 可省：新建时通常还没有内容，先要一个空壳去承载后续的
     PUT /revisions。给全了就照收，省掉「建完再存一次」的往返。 */
  const input: RevisionInput = {
    title: requiredString(body.title, "title", 200),
    edition: optionalString(body.edition, "edition", 100),
    note: optionalString(body.note, "note", 2_000),
    content: body.content === undefined || body.content === null
      ? EMPTY_CONTENT()
      : (() => {
          const content = objectValue(body.content, "content");
          assertContentShape(content);
          return content;
        })(),
  };

  const existing = await first<{ id: string }>(env.DB, "select id from guide_documents where slug=?", [slug]);
  if (existing) throw new HttpError(409, "conflict", `A guide document with slug "${slug}" already exists`);

  const id = makeId("guide");
  const revisionId = makeId("grev");
  const now = isoNow();
  const contentJson = jsonString(input.content);
  const contentHash = await sha256(contentJson);

  await env.DB.batch([
    env.DB.prepare(
      `insert into guide_documents(id,slug,title,lifecycle_status,current_revision_id,created_by,created_at,updated_at)
       values(?,?,?,'draft',null,?,?,?)`,
    ).bind(id, slug, input.title, principal.userId, now, now),
    env.DB.prepare(
      `insert into guide_revisions(id,document_id,revision_no,editorial_status,title,edition,note,content_json,content_hash,created_by,created_at)
       values(?,?,1,'draft',?,?,?,?,?,?,?)`,
    ).bind(revisionId, id, input.title, input.edition, input.note, contentJson, contentHash, principal.userId, now),
  ]);
  await audit(env, principal, "guide.create", "guide_document", id, requestId, null, {
    slug, title: input.title, revisionId, contentHash,
  });
  return json({ id, revisionId, revisionNo: 1, editorialStatus: "draft", contentHash }, { status: 201 });
}

/**
 * 保存内容。语义是「保存草稿」而不是「每次都开新版」：
 *
 *   - 已有 draft            → 原地更新那一版（编辑器每次保存不该堆版本号）
 *   - 只有 in_review        → 拒绝（送审中不能改，否则复核人看到的东西会变）
 *   - 只有 approved/published → 开新的一版 draft，版本号 +1
 *
 * 同内容重复保存直接返回 unchanged，不写库 —— 编辑器可能因为失焦触发多次保存。
 */
export async function saveGuideRevision(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  documentId: string,
  requestId: string,
): Promise<Response> {
  const document = await first<{ id: string }>(env.DB, "select id from guide_documents where id=?", [documentId]);
  if (!document) throw new HttpError(404, "not_found", "Guide document does not exist");

  const input = await readRevisionInput(request);
  const contentJson = jsonString(input.content);
  const contentHash = await sha256(contentJson);
  const now = isoNow();

  const open = await first<{ id: string; revisionNo: number; editorialStatus: string; contentHash: string }>(
    env.DB,
    `select id,revision_no as revisionNo,editorial_status as editorialStatus,content_hash as contentHash
       from guide_revisions
      where document_id=? and editorial_status in ('draft','in_review')
      order by case editorial_status when 'in_review' then 0 else 1 end,revision_no desc limit 1`,
    [documentId],
  );

  if (open && open.editorialStatus === "in_review") {
    throw new HttpError(
      409,
      "invalid_state",
      "This revision is under review. Withdraw it or wait for a decision before editing.",
    );
  }

  if (open) {
    if (open.contentHash === contentHash) {
      return json({ id: open.id, revisionNo: open.revisionNo, editorialStatus: "draft", contentHash, unchanged: true });
    }
    await env.DB.prepare(
      "update guide_revisions set title=?,edition=?,note=?,content_json=?,content_hash=? where id=?",
    ).bind(input.title, input.edition, input.note, contentJson, contentHash, open.id).run();
    await env.DB.prepare("update guide_documents set title=?,updated_at=? where id=?")
      .bind(input.title, now, documentId).run();
    await audit(env, principal, "guide.revision.update", "guide_revision", open.id, requestId,
      { contentHash: open.contentHash }, { contentHash, title: input.title });
    return json({ id: open.id, revisionNo: open.revisionNo, editorialStatus: "draft", contentHash });
  }

  const last = await first<{ revisionNo: number }>(
    env.DB,
    "select revision_no as revisionNo from guide_revisions where document_id=? order by revision_no desc limit 1",
    [documentId],
  );
  const revisionNo = (last?.revisionNo ?? 0) + 1;
  const revisionId = makeId("grev");
  await env.DB.batch([
    env.DB.prepare(
      `insert into guide_revisions(id,document_id,revision_no,editorial_status,title,edition,note,content_json,content_hash,created_by,created_at)
       values(?,?,?,'draft',?,?,?,?,?,?,?)`,
    ).bind(revisionId, documentId, revisionNo, input.title, input.edition, input.note, contentJson, contentHash, principal.userId, now),
    env.DB.prepare("update guide_documents set title=?,updated_at=? where id=?").bind(input.title, now, documentId),
  ]);
  await audit(env, principal, "guide.revision.create", "guide_revision", revisionId, requestId, null, {
    documentId, revisionNo, contentHash,
  });
  return json({ id: revisionId, revisionNo, editorialStatus: "draft", contentHash }, { status: 201 });
}

/** 送审。只有 draft 能送，送审后内容冻结（saveGuideRevision 会拒绝改动）。 */
export async function submitGuideRevision(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  revisionId: string,
  requestId: string,
): Promise<Response> {
  const body = await readJsonLimited<Record<string, unknown>>(request, 8 * 1024).catch(() => ({}) as Record<string, unknown>);
  const note = optionalString(body.note, "note", 2_000);
  const row = await first<{ id: string; documentId: string; editorialStatus: string }>(
    env.DB,
    "select id,document_id as documentId,editorial_status as editorialStatus from guide_revisions where id=?",
    [revisionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Guide revision does not exist");
  if (row.editorialStatus !== "draft") {
    throw new HttpError(409, "invalid_state", "Only draft revisions can be submitted for review");
  }
  const now = isoNow();
  await env.DB.prepare(
    "update guide_revisions set editorial_status='in_review',submitted_at=?,note=coalesce(?,note) where id=?",
  ).bind(now, note, revisionId).run();
  await audit(env, principal, "guide.revision.submit", "guide_revision", revisionId, requestId,
    { editorialStatus: "draft" }, { editorialStatus: "in_review", note });
  return json({ id: revisionId, editorialStatus: "in_review" });
}

/**
 * 审核决议。
 *
 * 批准不等于上线：还要显式调 publishGuideRevision。分成两步是因为
 * 「内容通过复核」和「现在就换掉线上版本」是两个决定 —— 开学前可以先审好，
 * 到日子再发。
 *
 * approved 是终态，批准新版时不把旧的 approved 版标成 superseded。
 * 早先的写法（照抄 place/facility 的「至多一版 approved」）会让回滚失效：
 * 发布守卫只认 approved，旧版一旦被 superseded 就再也发不回去，
 * 而回滚恰恰是这个模块最要紧的能力 —— 票价错了要能立刻退回上一版。
 * 「当前是哪一版」由 guide_documents.current_revision_id 唯一确定，
 * 不需要再用 editorial_status 表达一次。
 */
export async function reviewGuideRevision(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  revisionId: string,
  requestId: string,
): Promise<Response> {
  const body = await readJsonLimited<Record<string, unknown>>(request, 8 * 1024);
  const decision = oneOf(body.decision, "decision", ["approve", "reject"] as const);
  const note = optionalString(body.note, "note", 2_000);
  const row = await first<{ id: string; documentId: string; editorialStatus: string }>(
    env.DB,
    "select id,document_id as documentId,editorial_status as editorialStatus from guide_revisions where id=?",
    [revisionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Guide revision does not exist");
  if (row.editorialStatus !== "in_review") {
    throw new HttpError(409, "invalid_state", "Only revisions in review can be decided");
  }
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  const now = isoNow();
  /* 批准时不把旧的 approved 版降级为 superseded。
     曾经这么做过，结果回滚彻底不可用：发布触发器只认 approved，一旦上一版被降级，
     「退回上一版」就永远失败（本地冒烟用例 13 抓到）。
     「当前线上是哪一版」由 guide_documents.current_revision_id 单独表达，本来就没有歧义，
     不需要再用 editorial_status 去编码一次 —— 一份事实两处存储，才是矛盾的来源。
     所以 approved 是「复核通过、可发布」的持久属性：历史版本保持可回滚。 */
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "update guide_revisions set editorial_status=?,reviewed_by=?,reviewed_at=?,review_note=? where id=?",
    ).bind(nextStatus, principal.userId, now, note, revisionId),
    env.DB.prepare("update guide_documents set updated_at=? where id=?").bind(now, row.documentId),
  ];
  await env.DB.batch(statements);
  await audit(env, principal, `guide.revision.${decision}`, "guide_revision", revisionId, requestId,
    { editorialStatus: "in_review" }, { editorialStatus: nextStatus, note });
  return json({ id: revisionId, editorialStatus: nextStatus });
}

/**
 * 发布 / 回滚 —— 同一个动作：把 current_revision_id 指向某个 approved 版本。
 * 指向更新的版本叫发布，指向更早的叫回滚，机制完全一样。
 *
 * 「只能指向 approved 版」这条由 D1 触发器兜底（0020 迁移里的
 * guide_documents_publish_requires_approval），所以即使有人绕过这个函数
 * 直接改库也不会把草稿发上线。
 */
export async function publishGuideRevision(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  documentId: string,
  requestId: string,
): Promise<Response> {
  const body = await readJsonLimited<Record<string, unknown>>(request, 8 * 1024);
  const revisionId = requiredString(body.revisionId, "revisionId", 80);
  const document = await first<{ id: string; currentRevisionId: string | null }>(
    env.DB,
    "select id,current_revision_id as currentRevisionId from guide_documents where id=?",
    [documentId],
  );
  if (!document) throw new HttpError(404, "not_found", "Guide document does not exist");
  const revision = await first<{ id: string; editorialStatus: string; revisionNo: number }>(
    env.DB,
    "select id,editorial_status as editorialStatus,revision_no as revisionNo from guide_revisions where id=? and document_id=?",
    [revisionId, documentId],
  );
  if (!revision) throw new HttpError(404, "not_found", "Guide revision does not belong to this document");
  if (revision.editorialStatus !== "approved") {
    throw new HttpError(409, "invalid_state", "Only an approved revision can be published");
  }
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      "update guide_documents set current_revision_id=?,lifecycle_status='published',updated_at=? where id=?",
    ).bind(revisionId, now, documentId),
  ]);
  await audit(env, principal, "guide.publish", "guide_document", documentId, requestId,
    { currentRevisionId: document.currentRevisionId }, { currentRevisionId: revisionId, revisionNo: revision.revisionNo });
  return json({ id: documentId, currentRevisionId: revisionId, lifecycleStatus: "published" });
}

/** 下线：清空 current_revision_id，前台立刻 404。内容与历史都保留。 */
export async function unpublishGuideDocument(
  env: Env,
  principal: SessionPrincipal,
  documentId: string,
  requestId: string,
): Promise<Response> {
  const document = await first<{ id: string; currentRevisionId: string | null }>(
    env.DB,
    "select id,current_revision_id as currentRevisionId from guide_documents where id=?",
    [documentId],
  );
  if (!document) throw new HttpError(404, "not_found", "Guide document does not exist");
  const now = isoNow();
  await env.DB.prepare(
    "update guide_documents set current_revision_id=null,lifecycle_status='draft',updated_at=? where id=?",
  ).bind(now, documentId).run();
  await audit(env, principal, "guide.unpublish", "guide_document", documentId, requestId,
    { currentRevisionId: document.currentRevisionId }, { currentRevisionId: null });
  return json({ id: documentId, currentRevisionId: null, lifecycleStatus: "draft" });
}

// ---------------------------------------------------------------------------
// 管理端：图示素材
// ---------------------------------------------------------------------------

export async function listGuideAssets(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select a.id,a.asset_key as assetKey,a.asset_kind as assetKind,a.metadata_json as metadataJson,
            a.created_at as createdAt,a.updated_at as updatedAt,
            m.byte_size as byteSize,m.content_type as contentType,m.sha256
       from guide_assets a join media_assets m on m.id=a.media_asset_id
      order by a.asset_key`,
  );
  return json({
    items: items.map((row) => {
      const { metadataJson, ...rest } = row as Record<string, unknown> & { metadataJson: string };
      return { ...rest, metadata: parseJsonObject(metadataJson, "guide asset metadata") };
    }),
  });
}

/**
 * PUT /api/admin/guide/assets/:key — 上传或替换一张素材（raw body）。
 *
 * 用 PUT 而不是 POST：asset_key 由调用方指定（它要和内容里的 card.figure 对得上），
 * 同 key 重传就是替换，天然幂等。替换时旧的 media_assets 行标记 deleted 而不是
 * 物理删除 —— 审计需要能回答「这张图什么时候被谁换掉的」。
 *
 * ?kind= 决定接受什么：figure_svg / icon_svg 走 SVG 消毒，figure_png 校验魔术字节。
 */
export async function uploadGuideAsset(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  key: string,
  requestId: string,
): Promise<Response> {
  if (!ASSET_KEY_PATTERN.test(key)) {
    throw new HttpError(400, "validation_error", "asset key must be lowercase letters, digits and dashes (3-64 chars)");
  }
  const url = new URL(request.url);
  const kind = oneOf(url.searchParams.get("kind") ?? "figure_svg", "kind", ASSET_KINDS);

  const bytes = await readBodyLimited(request, MAX_ASSET_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "validation_error", "Asset body is empty");

  /* figure_png 实际收 PNG 和 JPEG 两种位图（名字里的 png 是历史叫法）；
     存进 R2 / media_assets 的 content-type 以嗅探结果为准。 */
  let storedType: string = ASSET_CONTENT_TYPE[kind];
  const metadata: Record<string, unknown> = {};
  if (storedType === "image/svg+xml") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    assertSafeSvg(text);
    const viewBox = /viewbox\s*=\s*["']([^"']+)["']/i.exec(text);
    if (viewBox) metadata.viewBox = viewBox[1].trim();
    const width = /<svg[^>]*\swidth\s*=\s*["']([^"']+)["']/i.exec(text);
    const height = /<svg[^>]*\sheight\s*=\s*["']([^"']+)["']/i.exec(text);
    if (width) metadata.width = width[1].trim();
    if (height) metadata.height = height[1].trim();
  } else {
    storedType = sniffRasterType(bytes);
    if (storedType === "image/png") {
      const view = new DataView(bytes);
      // PNG IHDR：宽高是第 16-23 字节。渲染时给 <img> 定尺寸，避免布局跳动。
      if (view.byteLength >= 24) {
        metadata.pixelWidth = view.getUint32(16);
        metadata.pixelHeight = view.getUint32(20);
      }
    }
  }

  const digest = await sha256(bytes);
  const now = isoNow();
  const existing = await first<{ id: string; mediaAssetId: string; assetKind: string }>(
    env.DB,
    "select id,media_asset_id as mediaAssetId,asset_kind as assetKind from guide_assets where asset_key=?",
    [key],
  );

  const mediaId = makeId("media");
  const ext = storedType === "image/png" ? "png" : storedType === "image/jpeg" ? "jpg" : "svg";
  const objectKey = `${GUIDE_ASSET_PREFIX}${mediaId}.${ext}`;
  await env.SHUMAP_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType: storedType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { scope: "public", guideAssetKey: key, uploadedBy: principal.userId },
  });

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,uploaded_by,created_at,approved_at)
       values(?,'public',?,?,?,?,?,'published',?,?,?)`,
    ).bind(mediaId, objectKey, key, storedType, bytes.byteLength, digest, principal.userId, now, now),
  ];
  if (existing) {
    statements.push(
      env.DB.prepare("update guide_assets set asset_kind=?,media_asset_id=?,metadata_json=?,updated_at=? where id=?")
        .bind(kind, mediaId, jsonString(metadata), now, existing.id),
      // 旧行留档但不再可读：getPublicGuideAsset 只认 status='published'
      env.DB.prepare("update media_assets set status='deleted' where id=?").bind(existing.mediaAssetId),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `insert into guide_assets(id,asset_key,asset_kind,media_asset_id,metadata_json,created_by,created_at,updated_at)
         values(?,?,?,?,?,?,?,?)`,
      ).bind(makeId("gasset"), key, kind, mediaId, jsonString(metadata), principal.userId, now, now),
    );
  }
  await env.DB.batch(statements);
  await audit(env, principal, existing ? "guide.asset.replace" : "guide.asset.create", "guide_asset", key, requestId,
    existing ? { mediaAssetId: existing.mediaAssetId } : null,
    { mediaAssetId: mediaId, assetKind: kind, byteSize: bytes.byteLength, sha256: digest });

  return json(
    { assetKey: key, assetKind: kind, mediaId, byteSize: bytes.byteLength, contentType: storedType, metadata },
    { status: existing ? 200 : 201 },
  );
}

/**
 * 删除一张素材。仍被已发布内容引用时拒绝 —— 否则前台会出现图片缺失的空框。
 * 检查的是「已发布版本的正文里是否出现这个 key」，草稿引用不阻塞删除。
 */
export async function deleteGuideAsset(
  env: Env,
  principal: SessionPrincipal,
  key: string,
  requestId: string,
): Promise<Response> {
  const existing = await first<{ id: string; mediaAssetId: string }>(
    env.DB,
    "select id,media_asset_id as mediaAssetId from guide_assets where asset_key=?",
    [key],
  );
  if (!existing) throw new HttpError(404, "not_found", "Guide asset does not exist");

  const referencing = await first<{ slug: string }>(
    env.DB,
    `select d.slug from guide_documents d
       join guide_revisions r on r.id=d.current_revision_id
      where d.lifecycle_status='published' and instr(r.content_json,?)>0 limit 1`,
    [`"${key}"`],
  );
  if (referencing) {
    throw new HttpError(
      409,
      "in_use",
      `Asset is still referenced by the published guide "${referencing.slug}". Update the content first.`,
    );
  }

  await env.DB.batch([
    env.DB.prepare("delete from guide_assets where id=?").bind(existing.id),
    env.DB.prepare("update media_assets set status='deleted' where id=?").bind(existing.mediaAssetId),
  ]);
  await audit(env, principal, "guide.asset.delete", "guide_asset", key, requestId,
    { mediaAssetId: existing.mediaAssetId }, null);
  return json({ assetKey: key, deleted: true });
}
