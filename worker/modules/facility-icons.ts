/**
 * facility-icons.ts — 后台可上传的设施图标
 *
 * 背景：facility_types.icon_key 此前只能取 facility-types.ts 里 SUPPORTED_ICON_KEYS
 * 那 23 个硬编码值。加一枚图标要改三处代码（Web 的 key→lucide 组件表、
 * generate-tab-icons.mjs 的 key→lucide 名、清单本身）再发一次版，所以后台没有入口。
 *
 * 这个模块把「key → 图形」搬到服务端：上传 SVG，行落 facility_icons、字节落 R2，
 * icon_key 存 `custom-<slug>`。客户端按 custom- 前缀判断走内置组件还是来这里取图。
 *
 * 两个刻意的设计：
 *
 * 1. 颜色由服务端替换，不靠 CSS 继承。图钉有两态（未选中=白底蓝图标，
 *    选中=蓝底白图标），而 <img>/<image> 引用的 SVG 是独立文档，继承不到外面的
 *    color。小程序侧更不能指望 CSS —— 开发者工具的 SVG 解码器会忽略靠后的选择器
 *    规则（miniprogram/AGENTS.md 记过这个坑）。所以要求源文件只写 currentColor，
 *    读取时按 ?ink= 把 currentColor 直接换成色值，两端拿到的都是已上色的死图。
 *
 * 2. 上传校验一律拒收，不自动改写。改写要穷举所有写法，漏一个就产出一枚颜色改不掉
 *    的图标；拒收能明确告诉上传者去改源文件。同 svg-safety.ts 的理由。
 */
import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readBodyLimited, readJson } from "../lib/http";
import { assertSafeSvg } from "../lib/svg-safety";
import { isoNow, jsonString, makeId, oneOf, optionalString, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";

/** R2 前缀。与 public/media/、public/guide-assets/ 分开，便于单独盘点。 */
const ICON_PREFIX = "public/facility-icons/";

/**
 * 单枚图标上限。一枚 24×24 的线框图标压出来通常 1–3KB；64KB 已经宽到能装
 * 相当复杂的路径，又小到不可能是「整张插画传错了」。
 */
const MAX_ICON_BYTES = 64 * 1024;

/**
 * icon_key 的形状。必须带 custom- 前缀（客户端据此分流），总长 ≤50 —— 因为它要
 * 存进 facility_types.icon_key，那一列的写入校验是 optionalString(…, 50)。
 */
const ICON_KEY_PATTERN = /^custom-(?=.{2,42}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STATUSES = ["active", "disabled"] as const;

/**
 * ?ink= 的两档，对齐两端图钉的两个态：
 *   primary  未选中（白底蓝图标）—— 与 --color-primary、小程序 images/poi/ 同色
 *   white    选中（蓝底白图标）—— 与小程序 images/poi-w/ 同色
 * 只枚举两档而不收任意色值：任意色值等于给缓存开一个无穷维度，也多一个注入面。
 */
const INKS: Record<string, string> = {
  primary: "#1e80c1",
  white: "#ffffff",
};

const DEFAULT_INK = "primary";

interface FacilityIconRow {
  id: string;
  iconKey: string;
  label: string;
  status: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
  byteSize: number;
  sha256: string;
  /** 有多少个设施类型正在用它。>0 时不允许删除。 */
  usageCount: number;
}

/**
 * 颜色必须可替换。
 *
 * 三条判定，都要求「显式写 currentColor」而不是「碰巧能继承」：
 *   ① fill / stroke 的值只能是 currentColor 或 none
 *   ② 不能有 <style> 块或渐变/图案定义 —— 它们绕过上面那条，且渐变必然多色
 *   ③ 整份文件至少出现一次 currentColor
 *
 * 第 ③ 条是为了堵「一个 fill/stroke 都没写」的情况：那种 SVG 的默认填充是黑色，
 * 替换无从下手，画在蓝底上几乎看不见。要求至少写一次，等于要求上传者表达意图。
 */
function assertReplaceableColors(text: string): void {
  const lower = text.toLowerCase();

  if (/<style[\s>]/.test(lower)) {
    throw new HttpError(
      400,
      "icon_color_not_replaceable",
      "图标不能带 <style> 样式块：颜色要能被替换成选中态的白色，请把 fill / stroke 直接写在图形上，值用 currentColor。",
    );
  }
  for (const tag of ["lineargradient", "radialgradient", "pattern"]) {
    if (new RegExp(`<${tag}[\\s>]`).test(lower)) {
      throw new HttpError(
        400,
        "icon_color_not_replaceable",
        "图标不能用渐变或图案填充：地图图钉只有单色两态（蓝 / 白），请改成单色描边，颜色写 currentColor。",
      );
    }
  }

  // fill="…" / stroke="…" 属性
  const attributes = lower.match(/\b(?:fill|stroke)\s*=\s*["'][^"']*["']/g) ?? [];
  for (const raw of attributes) {
    const value = raw.slice(raw.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "").trim();
    if (value !== "currentcolor" && value !== "none") {
      throw new HttpError(
        400,
        "icon_color_not_replaceable",
        `图标里写死了颜色（${value}）。fill / stroke 只能填 currentColor 或 none，`
        + "否则选中态（蓝底白图标）无法上色。",
      );
    }
  }

  // style="fill:…;stroke:…" 内联声明
  const declarations = lower.match(/(?:fill|stroke)\s*:\s*[^;"'}]+/g) ?? [];
  for (const raw of declarations) {
    const value = raw.slice(raw.indexOf(":") + 1).trim();
    if (value !== "currentcolor" && value !== "none") {
      throw new HttpError(
        400,
        "icon_color_not_replaceable",
        `图标的 style 里写死了颜色（${value}）。fill / stroke 只能填 currentColor 或 none。`,
      );
    }
  }

  if (!lower.includes("currentcolor")) {
    throw new HttpError(
      400,
      "icon_color_not_replaceable",
      "图标里没有出现 currentColor：请给描边或填充显式写 stroke=\"currentColor\"（或 fill=\"currentColor\"），"
      + "服务端据此换成蓝 / 白两态的颜色。",
    );
  }
}

/** viewBox 是必需的：两端都按容器尺寸缩放图标，没有 viewBox 就没有等比缩放的依据。 */
function iconMetadata(text: string): Record<string, unknown> {
  const viewBox = /viewbox\s*=\s*["']([^"']+)["']/i.exec(text);
  if (!viewBox) {
    throw new HttpError(
      400,
      "validation_error",
      "SVG 必须带 viewBox（建议 0 0 24 24），否则在地图和列表里无法等比缩放。",
    );
  }
  const metadata: Record<string, unknown> = { viewBox: viewBox[1].trim() };
  const width = /<svg[^>]*\swidth\s*=\s*["']([^"']+)["']/i.exec(text);
  const height = /<svg[^>]*\sheight\s*=\s*["']([^"']+)["']/i.exec(text);
  if (width) metadata.width = width[1].trim();
  if (height) metadata.height = height[1].trim();
  return metadata;
}

/**
 * 把 currentColor 换成实际色值，并在根 <svg> 上补一个 color，
 * 兜住路径里可能残留的 currentColor（换完理论上没有，但补一句不花钱）。
 */
export function inkedSvg(text: string, ink: string): string {
  const color = INKS[ink] ?? INKS[DEFAULT_INK];
  const replaced = text.replace(/currentColor/gi, color);
  return replaced.replace(/<svg\b/i, `<svg style="color:${color}"`);
}

/** GET /api/admin/facility-icons —— 全部自定义图标 + 各自被多少类型引用。 */
export async function listFacilityIcons(env: Env): Promise<Response> {
  const items = await all<FacilityIconRow>(
    env.DB,
    `select i.id,i.icon_key as iconKey,i.label,i.status,i.metadata_json as metadataJson,
            i.created_at as createdAt,i.updated_at as updatedAt,
            m.byte_size as byteSize,m.sha256,
            (select count(*) from facility_types t where t.icon_key=i.icon_key) as usageCount
       from facility_icons i join media_assets m on m.id=i.media_asset_id
      order by i.created_at desc`,
  );
  return json({
    items: items.map((row) => {
      const { metadataJson, ...rest } = row;
      return { ...rest, metadata: JSON.parse(metadataJson) as Record<string, unknown> };
    }),
  });
}

/**
 * PUT /api/admin/facility-icons/:key?label=… —— 上传或替换一枚图标（raw SVG body）。
 *
 * 用 PUT 而不是 POST：键由调用方指定（它要存进 facility_types.icon_key），
 * 同键重传即替换，天然幂等，且换图之后引用它的类型不用改一个字。
 * 替换时旧的 media_assets 行标记 deleted 而非物删 —— 审计要能回答「谁什么时候换的」。
 */
export async function uploadFacilityIcon(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  key: string,
  requestId: string,
): Promise<Response> {
  if (!ICON_KEY_PATTERN.test(key)) {
    throw new HttpError(
      400,
      "invalid_icon_key",
      "图标编码必须形如 custom-water-dispenser：custom- 前缀 + 小写字母/数字/连字符，总长不超过 50。",
    );
  }
  const url = new URL(request.url);
  const labelParam = optionalString(url.searchParams.get("label"), "label", 30);

  const bytes = await readBodyLimited(request, MAX_ICON_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "validation_error", "上传内容为空");

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  assertSafeSvg(text);
  assertReplaceableColors(text);
  const metadata = iconMetadata(text);

  const existing = await first<{ id: string; mediaAssetId: string; label: string }>(
    env.DB,
    "select id,media_asset_id as mediaAssetId,label from facility_icons where icon_key=?",
    [key],
  );
  // 新建必须给名字（图标网格要显示它）；替换时不给就沿用原名。
  const label = labelParam ?? (existing ? existing.label : null);
  if (label === null) {
    throw new HttpError(400, "validation_error", "新图标必须填写名称（显示在后台图标选择器里）");
  }

  const digest = await sha256(bytes);
  const now = isoNow();
  const mediaId = makeId("media");
  const objectKey = `${ICON_PREFIX}${mediaId}.svg`;
  await env.SHUMAP_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType: "image/svg+xml", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { scope: "public", facilityIconKey: key, uploadedBy: principal.userId },
  });

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,uploaded_by,created_at,approved_at)
       values(?,'public',?,?,'image/svg+xml',?,?,'published',?,?,?)`,
    ).bind(mediaId, objectKey, key, bytes.byteLength, digest, principal.userId, now, now),
  ];
  if (existing) {
    statements.push(
      env.DB.prepare("update facility_icons set label=?,media_asset_id=?,metadata_json=?,updated_at=? where id=?")
        .bind(label, mediaId, jsonString(metadata), now, existing.id),
      env.DB.prepare("update media_assets set status='deleted' where id=?").bind(existing.mediaAssetId),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `insert into facility_icons(id,icon_key,label,media_asset_id,metadata_json,status,created_by,created_at,updated_at)
         values(?,?,?,?,?,'active',?,?,?)`,
      ).bind(makeId("facicon"), key, label, mediaId, jsonString(metadata), principal.userId, now, now),
    );
  }
  await env.DB.batch(statements);

  await audit(
    env, principal, existing ? "facility_icon.replace" : "facility_icon.create", "facility_icon", key, requestId,
    existing ? { mediaAssetId: existing.mediaAssetId, label: existing.label } : null,
    { mediaAssetId: mediaId, label, byteSize: bytes.byteLength, sha256: digest },
  );

  return json(
    { iconKey: key, label, byteSize: bytes.byteLength, status: "active", metadata },
    { status: existing ? 200 : 201 },
  );
}

/**
 * PATCH /api/admin/facility-icons/:key —— 改名 / 停用启用。
 *
 * 停用的意义：一枚图标只要还有类型在用就删不掉（见下），但「不想再让人选它」
 * 是个独立的需求。停用后它不再作为新建选项，已经引用它的类型照常显示。
 * 与 facility_types 的 disable-vs-delete 是同一套语义。
 */
export async function updateFacilityIcon(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  key: string,
  requestId: string,
): Promise<Response> {
  const current = await first<{ id: string; label: string; status: string }>(
    env.DB,
    "select id,label,status from facility_icons where icon_key=?",
    [key],
  );
  if (!current) throw new HttpError(404, "not_found", "图标不存在");

  const body = await readJson<{ label?: unknown; status?: unknown }>(request);
  const label = body.label === undefined ? null : requiredString(body.label, "label", 30);
  const status = body.status === undefined ? null : oneOf(body.status, "status", STATUSES);
  if (label === null && status === null) throw new HttpError(400, "validation_error", "没有要修改的内容");

  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (label !== null) { sets.push("label=?"); values.push(label); }
  if (status !== null) { sets.push("status=?"); values.push(status); }
  sets.push("updated_at=?");
  values.push(isoNow(), current.id);
  await env.DB.prepare(`update facility_icons set ${sets.join(",")} where id=?`).bind(...values).run();

  await audit(env, principal, "facility_icon.update", "facility_icon", key, requestId,
    { label: current.label, status: current.status },
    { label: label ?? current.label, status: status ?? current.status });
  return json({ iconKey: key, label: label ?? current.label, status: status ?? current.status });
}

/**
 * DELETE /api/admin/facility-icons/:key —— 仅在没有设施类型引用时物理删除。
 *
 * 这条检查是这张表不复用 guide_assets 的原因：那边的删除保护只看指南正文，
 * 设施图标混进去会被判成「没人引用」删掉，引用它的类型在地图上就变成通用图钉。
 */
export async function deleteFacilityIcon(
  env: Env,
  principal: SessionPrincipal,
  key: string,
  requestId: string,
): Promise<Response> {
  const existing = await first<{ id: string; mediaAssetId: string; label: string }>(
    env.DB,
    "select id,media_asset_id as mediaAssetId,label from facility_icons where icon_key=?",
    [key],
  );
  if (!existing) throw new HttpError(404, "not_found", "图标不存在");

  const user = await first<{ name: string }>(
    env.DB,
    "select name from facility_types where icon_key=? limit 1",
    [key],
  );
  if (user) {
    throw new HttpError(
      409,
      "facility_icon_in_use",
      `设施类型「${user.name}」还在用这枚图标，不能删除。可以先把它停用，或给那个类型换一枚图标。`,
    );
  }

  await env.DB.batch([
    env.DB.prepare("delete from facility_icons where id=?").bind(existing.id),
    env.DB.prepare("update media_assets set status='deleted' where id=?").bind(existing.mediaAssetId),
  ]);
  await audit(env, principal, "facility_icon.delete", "facility_icon", key, requestId,
    { label: existing.label, mediaAssetId: existing.mediaAssetId }, null);
  return json({ iconKey: key, deleted: true });
}

/**
 * GET /api/public/facility-icons/:key?ink=primary|white
 *
 * 按键寻址，而同一个键的图是会被替换的（换图后引用它的类型自动跟着换，这正是
 * 按键寻址的目的），所以不能用 immutable —— 那会让浏览器一年内不再回源。
 * 用 must-revalidate + ETag：每次问一句，没变则 304，字节量与 immutable 相当。
 *
 * ETag 必须带上 ink：同一份字节按 ink 输出两种颜色，共用一个 ETag 会让第二种
 * 颜色拿到第一种的缓存（蓝图标画在蓝底上）。
 */
export async function getPublicFacilityIcon(request: Request, env: Env, key: string): Promise<Response> {
  if (!ICON_KEY_PATTERN.test(key)) throw new HttpError(404, "not_found", "图标不存在");
  const url = new URL(request.url);
  const inkParam = url.searchParams.get("ink");
  const ink = inkParam === null || inkParam === "" ? DEFAULT_INK : inkParam;
  if (!Object.hasOwn(INKS, ink)) {
    throw new HttpError(400, "validation_error", `ink must be one of: ${Object.keys(INKS).join(", ")}`);
  }

  const row = await first<{ objectKey: string; byteSize: number; sha256: string; status: string }>(
    env.DB,
    `select m.object_key as objectKey,m.byte_size as byteSize,m.sha256,m.status
       from facility_icons i join media_assets m on m.id=i.media_asset_id
      where i.icon_key=? and m.bucket_scope='public'`,
    [key],
  );
  if (!row || row.status !== "published" || !row.objectKey.startsWith(ICON_PREFIX)) {
    throw new HttpError(404, "not_found", "图标不存在");
  }

  const etag = `"${row.sha256}-${ink}"`;
  const headers = {
    "content-type": "image/svg+xml",
    "content-disposition": "inline",
    "cache-control": "public, max-age=0, must-revalidate",
    etag,
    "x-content-type-options": "nosniff",
    // 图标是纯图形：不需要外部资源，也不需要内联样式之外的任何东西。
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }

  const object = await env.SHUMAP_BUCKET.get(row.objectKey);
  if (!object) throw new HttpError(404, "not_found", "图标文件缺失");
  if (object.size !== row.byteSize) {
    throw new Error(`Facility icon ${key} object size ${object.size} does not match stored ${row.byteSize}`);
  }
  return new Response(inkedSvg(await object.text(), ink), { headers });
}

/** 客户端据此分流：自定义键去服务端取图，内置键走各端的图标表。 */
export function isCustomIconKey(iconKey: string | null | undefined): boolean {
  return typeof iconKey === "string" && iconKey.startsWith("custom-");
}
