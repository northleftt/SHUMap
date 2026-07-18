type Env = {
  DB?: D1Database;
  SHUMAP_BUCKET?: R2Bucket;
  RELEASE_KV?: KVNamespace;
  IMPORT_QUEUE?: Queue;
  ASSETS?: Fetcher;
  ADMIN_TOKEN_SECRET?: string;
};

type D1Database = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
  batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]>;
};

type R2Bucket = {
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: unknown): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
};

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

type Queue = {
  send(message: unknown): Promise<void>;
};

type Fetcher = {
  fetch(request: Request): Promise<Response>;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const sampleOverview = {
  metrics: [
    { label: "地图版本", value: "3", hint: "三校区底图草稿已准备导入", severity: "info" },
    { label: "POI", value: "148", hint: "旧 JSON 等待迁移", severity: "warning" },
    { label: "Marker 类型", value: "6", hint: "校车点、公交站、打印机等", severity: "ok" },
    { label: "待发布", value: "1", hint: "新后台尚未发布快照", severity: "warning" },
  ],
  validationIssues: [
    {
      id: "bootstrap",
      title: "后台数据待初始化",
      detail: "请先导入三校区 SVG、旧 POI JSON 和校车时刻表。",
      severity: "warning",
      target: "初始化",
    },
  ],
  mapVersions: [],
  pois: [],
  markerTypes: [
    { id: "shuttle-stop", name: "校车点", icon: "bus", visibility: "contextual-only", count: 0 },
    { id: "bus-stop", name: "公交站", icon: "transit", visibility: "on-filter", count: 0 },
    { id: "printer", name: "打印机", icon: "printer", visibility: "on-search", count: 0 },
  ],
  routeOverlays: [],
  shuttleRoutes: [],
  releases: [],
  logs: [],
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function notFound() {
  return json({ error: "Not found" }, { status: 404 });
}

// ---------- Rate limiter ----------

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "/api/auth/login": { windowMs: 60_000, maxRequests: 10 },
  "/api/auth/setup": { windowMs: 300_000, maxRequests: 5 },
  "/api/admin": { windowMs: 60_000, maxRequests: 120 },
  default: { windowMs: 60_000, maxRequests: 300 },
};

function getRateLimitKey(ip: string, path: string): string {
  const now = Date.now();
  // Find matching config
  let config = RATE_LIMITS.default;
  for (const [prefix, cfg] of Object.entries(RATE_LIMITS)) {
    if (prefix !== "default" && path.startsWith(prefix)) {
      config = cfg;
      break;
    }
  }
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
  return `ratelimit:${ip}:${path}:${windowStart}`;
}

async function checkRateLimit(
  env: Env,
  request: Request,
  path: string,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  if (!env.DB) return { allowed: true, remaining: -1, retryAfter: 0 };

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = getRateLimitKey(ip, path);

  // Find matching config
  let config = RATE_LIMITS.default;
  for (const [prefix, cfg] of Object.entries(RATE_LIMITS)) {
    if (prefix !== "default" && path.startsWith(prefix)) {
      config = cfg;
      break;
    }
  }

  try {
    const now = nowIso();
    // Upsert and increment
    await env.DB.prepare(
      `insert into rate_limits (key, count, window_start, updated_at)
       values (?, 1, ?, ?)
       on conflict(key) do update set count = count + 1, updated_at = ?`
    ).bind(key, now, now, now).run();

    const record = await env.DB.prepare(
      "select count, window_start from rate_limits where key = ?"
    ).bind(key).first<{ count: number; window_start: string }>();

    const count = record?.count ?? 0;
    const remaining = Math.max(0, config.maxRequests - count);
    const allowed = count <= config.maxRequests;

    return { allowed, remaining, retryAfter: allowed ? 0 : Math.ceil(config.windowMs / 1000) };
  } catch {
    // If rate_limits table doesn't exist, allow
    return { allowed: true, remaining: -1, retryAfter: 0 };
  }
}

function nowIso() {
  return new Date().toISOString();
}

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function getTokenSecret(env: Env): string | null {
  return env.ADMIN_TOKEN_SECRET?.trim() || null;
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
  const hash = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${salt}:${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, originalHash] = stored.split(":");
  if (!salt || !originalHash) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
  const hash = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hash === originalHash;
}

async function createToken(payload: Record<string, unknown>, tokenSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: Date.now(), exp: Date.now() + TOKEN_EXPIRY_MS };
  const input = `${btoa(JSON.stringify(header))}.${btoa(JSON.stringify(body))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(tokenSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${input}.${sigStr}`;
}

async function verifyToken(token: string, tokenSecret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const encoder = new TextEncoder();
    const input = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(tokenSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(input));
    if (!valid) return null;
    const body = JSON.parse(atob(parts[1]));
    if (body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

async function requireAuth(request: Request, env: Env): Promise<{ email: string } | null> {
  const tokenSecret = getTokenSecret(env);
  if (!tokenSecret) return null;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const payload = await verifyToken(token, tokenSecret);
  if (!payload || !payload.email) return null;
  return { email: String(payload.email) };
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

async function parseJsonBody<T>(request: Request): Promise<Partial<T>> {
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}

async function readList(env: Env, table: string, orderBy = "updated_at desc") {
  if (!env.DB) return [];
  const result = await env.DB.prepare(`select * from ${table} order by ${orderBy} limit 200`).all();
  return result.results;
}

async function readAdminPois(env: Env) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    `select p.id, p.name, p.campus, p.category, p.geometry, p.status,
            p.detail_json as detailJson, p.navigation_json as navigationJson,
            p.created_at as createdAt, p.updated_at as updatedAt,
            count(pb.id) as bindingCount,
            primary_binding.binding_type as primaryBindingType,
            primary_binding.map_object_id as primaryMapObjectId,
            primary_object.raw_id as primaryMapObjectRawId,
            primary_object.normalized_id as primaryMapObjectNormalizedId,
            primary_object.bbox_json as primaryMapObjectBBoxJson,
            primary_binding.marker_id as primaryMarkerId,
            primary_marker.x as primaryMarkerX,
            primary_marker.y as primaryMarkerY,
            (
              select group_concat(pt.name, '、')
              from poi_tag_links ptl
              join poi_tags pt on pt.id = ptl.tag_id
              where ptl.poi_id = p.id
            ) as attributeNames,
            (
              select group_concat(pt.name, '、')
              from poi_tag_links ptl
              join poi_tags pt on pt.id = ptl.tag_id
              where ptl.poi_id = p.id
            ) as tagNames
     from pois p
     left join poi_bindings pb on pb.poi_id = p.id
     left join poi_bindings primary_binding on primary_binding.poi_id = p.id
       and primary_binding.id = (
         select pb2.id from poi_bindings pb2 where pb2.poi_id = p.id order by pb2.created_at desc limit 1
       )
     left join map_objects primary_object on primary_object.id = primary_binding.map_object_id
     left join markers primary_marker on primary_marker.id = primary_binding.marker_id
     group by p.id
     order by p.updated_at desc
     limit 500`,
  ).all();
  return result.results;
}

async function readPoiCategories(env: Env) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    `select pc.id, pc.name, pc.sort_order as sortOrder, count(p.id) as count
     from poi_categories pc
     left join pois p on p.category = pc.id
     group by pc.id
     order by pc.sort_order asc, pc.name asc`,
  ).all();
  return result.results;
}

async function readPoiAttributes(env: Env) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    `select pt.id, pt.name, pt.color, pt.sort_order as sortOrder,
            count(ptl.poi_id) as count
     from poi_tags pt
     left join poi_tag_links ptl on ptl.tag_id = pt.id
     group by pt.id
     order by pt.sort_order asc, pt.name asc`,
  ).all();
  return result.results;
}

async function readPoiAttributeIds(env: Env, poiId: string) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    "select tag_id as attributeId from poi_tag_links where poi_id = ? order by created_at asc",
  ).bind(poiId).all<{ attributeId: string }>();
  return result.results.map((item) => item.attributeId);
}

async function replacePoiAttributes(env: Env, poiId: string, attributeIds: string[] | undefined, createdAt = nowIso()) {
  if (!env.DB || !attributeIds) return;
  const uniqueAttributeIds = Array.from(new Set(attributeIds.filter(Boolean)));
  const statements = [
    env.DB.prepare("delete from poi_tag_links where poi_id = ?").bind(poiId),
    ...uniqueAttributeIds.map((attributeId) =>
      env.DB!.prepare("insert or ignore into poi_tag_links (poi_id, tag_id, created_at) values (?, ?, ?)")
        .bind(poiId, attributeId, createdAt),
    ),
  ];
  await env.DB.batch(statements);
}

const readPoiTags = readPoiAttributes;
const readPoiTagIds = readPoiAttributeIds;
const replacePoiTags = replacePoiAttributes;

async function readAdminMarkers(env: Env) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    `select m.id, m.marker_type_id as markerTypeId, mt.name as markerTypeName,
            m.campus, m.poi_id as poiId, p.name as poiName,
            m.parent_poi_id as parentPoiId, parent.name as parentPoiName,
            m.display_mode as displayMode, m.parent_space_id as parentSpaceId,
            m.floor_id as floorId, m.location_hint as locationHint,
            m.indoor_position_json as indoorPositionJson,
            m.x, m.y, m.status, m.meta_json as metaJson,
            m.created_at as createdAt, m.updated_at as updatedAt
     from markers m
     left join marker_types mt on mt.id = m.marker_type_id
     left join pois p on p.id = m.poi_id
     left join pois parent on parent.id = m.parent_poi_id
     order by m.updated_at desc
     limit 500`,
  ).all();
  return result.results;
}

async function readMarkerTypes(env: Env) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    `select id, name, icon, color, visibility,
            default_poi_category as defaultPoiCategory,
            default_attribute_ids as defaultAttributeIds,
            default_display_mode as defaultDisplayMode,
            creates_poi as createsPoi
     from marker_types
     order by name asc`,
  ).all();
  return result.results;
}

async function readMapObjectsForAdmin(env: Env, url: URL) {
  if (!env.DB) return [];
  const campus = url.searchParams.get("campus") || "";
  const versionId = url.searchParams.get("versionId") || "";
  const q = `%${(url.searchParams.get("q") || "").trim()}%`;

  if (versionId) {
    const result = await env.DB.prepare(
      `select id, map_version_id as mapVersionId, campus, raw_id as rawId,
              normalized_id as normalizedId, object_kind as objectKind,
              label_text as labelText
       from map_objects
       where map_version_id = ?
         and (? = '%%' or normalized_id like ? or raw_id like ? or coalesce(label_text, '') like ?)
       order by label_text is null, label_text, normalized_id
       limit 500`,
    ).bind(versionId, q, q, q, q).all();
    return result.results;
  }

  if (!campus) return [];
  const result = await env.DB.prepare(
    `select mo.id, mo.map_version_id as mapVersionId, mo.campus, mo.raw_id as rawId,
            mo.normalized_id as normalizedId, mo.object_kind as objectKind,
            mo.label_text as labelText
     from map_objects mo
     where mo.campus = ?
       and mo.map_version_id = (
         select id from map_versions where campus = ? order by created_at desc limit 1
       )
       and (? = '%%' or mo.normalized_id like ? or mo.raw_id like ? or coalesce(mo.label_text, '') like ?)
     order by mo.label_text is null, mo.label_text, mo.normalized_id
     limit 500`,
  ).bind(campus, campus, q, q, q, q).all();
  return result.results;
}

async function deleteById(env: Env, table: string, id: string, actor = "admin") {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  await env.DB.prepare(`delete from ${table} where id = ?`).bind(id).run();
  await writeLog(env, "audit", `Deleted ${table} ${id}`, actor);
  return json({ ok: true, id });
}

function normalizeIllustratorId(id: string) {
  return id
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/_x([0-9A-Fa-f]{2})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/_x5C_/g, "_");
}

function extractSvgObjects(svgText: string) {
  const objects: Array<{
    rawId: string;
    normalizedId: string;
    kind: string;
    text: string;
  }> = [];
  const idPattern = /<([a-zA-Z][\w:-]*)\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)(?:<\/\1>)?/g;
  let match: RegExpExecArray | null;
  while ((match = idPattern.exec(svgText))) {
    const [, tagName, rawId, body = ""] = match;
    if (rawId === "Layer_1") continue;
    const text = Array.from(body.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g))
      .map((textMatch) => textMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    objects.push({
      rawId,
      normalizedId: normalizeIllustratorId(rawId),
      kind: tagName.toLowerCase(),
      text,
    });
  }
  return objects;
}

async function writeLog(env: Env, level: string, message: string, actor = "system", meta?: unknown) {
  if (!env.DB) return;
  await env.DB.prepare(
    "insert into logs (id, level, message, actor, meta_json, created_at) values (?, ?, ?, ?, ?, ?)",
  )
    .bind(makeId("log"), level, message, actor, meta ? JSON.stringify(meta) : null, nowIso())
    .run();
}

async function readOverview(env: Env) {
  if (!env.DB) return sampleOverview;
  const [mapVersions, pois, markerTypes, routeOverlays, shuttleRoutes, releases, logs] =
    await Promise.all([
      env.DB.prepare(
        "select id, campus, version, status, object_count as objectCount, created_at as createdAt, unresolved_diffs as unresolvedDiffs from map_versions order by created_at desc limit 8",
      ).all(),
      env.DB.prepare(
        "select id, name, campus, category, geometry, status from pois order by updated_at desc limit 8",
      ).all(),
      env.DB.prepare(
        `select mt.id, mt.name, mt.icon, mt.color, mt.visibility,
                mt.default_poi_category as defaultPoiCategory,
                mt.default_attribute_ids as defaultAttributeIds,
                mt.default_display_mode as defaultDisplayMode,
                mt.creates_poi as createsPoi,
                count(m.id) as count
         from marker_types mt
         left join markers m on m.marker_type_id = mt.id
         group by mt.id
         order by mt.name`,
      ).all(),
      env.DB.prepare(
        "select id, name, campus, kind, status from route_overlays order by updated_at desc limit 8",
      ).all(),
      env.DB.prepare(
        "select id, from_campus as \"from\", to_campus as \"to\", weekday_trips as weekdayTrips, weekend_trips as weekendTrips, updated_at as updatedAt from shuttle_routes order by id limit 8",
      ).all(),
      env.DB.prepare(
        "select id, version, status, created_at as createdAt, summary from releases order by created_at desc limit 8",
      ).all(),
      env.DB.prepare(
        "select id, level, message, actor, created_at as createdAt from logs order by created_at desc limit 10",
      ).all(),
    ]);

  const blockerCount = await env.DB.prepare(
    "select count(*) as count from validation_issues where severity = 'error' and resolved_at is null",
  ).first<{ count: number }>();
  const warningCount = await env.DB.prepare(
    "select count(*) as count from validation_issues where severity = 'warning' and resolved_at is null",
  ).first<{ count: number }>();
  const mapVersionCount = await env.DB.prepare("select count(*) as count from map_versions").first<{ count: number }>();
  const markerCount = await env.DB.prepare("select count(*) as count from markers").first<{ count: number }>();
  const overlayCount = await env.DB.prepare("select count(*) as count from route_overlays").first<{ count: number }>();
  const poiCount = await env.DB.prepare("select count(*) as count from pois").first<{ count: number }>();

  const validationIssues = await env.DB.prepare(
    "select id, title, detail, severity, target from validation_issues where resolved_at is null order by created_at desc limit 8",
  ).all();

  return {
    metrics: [
      {
        label: "地图版本",
        value: String(mapVersionCount?.count ?? 0),
        hint: "已记录的地图版本",
        severity: "info",
      },
      {
        label: "POI",
        value: String(poiCount?.count ?? 0),
        hint: "当前数据库 POI 数量",
        severity: (warningCount?.count ?? 0) > 0 ? "warning" : "ok",
      },
      {
        label: "Marker",
        value: String(markerCount?.count ?? 0),
        hint: "独立点位与 POI 绑定",
        severity: "info",
      },
      {
        label: "路线图层",
        value: String(overlayCount?.count ?? 0),
        hint:
          (blockerCount?.count ?? 0) > 0
            ? "仍有发布阻塞"
            : `${warningCount?.count ?? 0} 个发布警告`,
        severity:
          (blockerCount?.count ?? 0) > 0
            ? "error"
            : (warningCount?.count ?? 0) > 0
              ? "warning"
              : "ok",
      },
    ],
    validationIssues: validationIssues.results,
    mapVersions: mapVersions.results,
    pois: pois.results,
    markerTypes: markerTypes.results,
    routeOverlays: routeOverlays.results,
    shuttleRoutes: shuttleRoutes.results,
    releases: releases.results,
    logs: logs.results,
  };
}

async function importSvg(request: Request, env: Env) {
  const body = (await request.json()) as {
    campus?: string;
    version?: string;
    fileName?: string;
    svgText?: string;
  };
  if (!body.campus || !body.svgText) {
    return json({ error: "campus and svgText are required" }, { status: 400 });
  }
  const objects = extractSvgObjects(body.svgText);
  const versionId = makeId("map");
  const version = body.version || `draft-${new Date().toISOString().slice(0, 10)}`;
  const createdAt = nowIso();

  if (!env.DB) {
    return json({
      id: versionId,
      campus: body.campus,
      version,
      objectCount: objects.length,
      diff: { added: objects.length, deleted: 0, matched: 0, changed: 0 },
      objects,
      note: "No D1 binding found; import was simulated.",
    });
  }

  const previousVersion = await env.DB.prepare(
    "select id from map_versions where campus = ? order by created_at desc limit 1",
  ).bind(body.campus).first<{ id: string }>();
  const previous = previousVersion
    ? await env.DB.prepare(
      "select normalized_id as normalizedId from map_objects where map_version_id = ?",
    ).bind(previousVersion.id).all<{ normalizedId: string }>()
    : { results: [] as Array<{ normalizedId: string }> };
  const previousIds = new Set(previous.results.map((item) => item.normalizedId));
  const nextIds = new Set(objects.map((item) => item.normalizedId));
  const added = previousVersion ? objects.filter((object) => !previousIds.has(object.normalizedId)) : [];
  const deleted = previousVersion ? previous.results.filter((object) => !nextIds.has(object.normalizedId)) : [];
  const matched = objects.length - added.length;
  const unresolvedDiffs = added.length + deleted.length;

  await env.DB.prepare(
    "insert into map_versions (id, campus, version, status, source_file_name, object_count, unresolved_diffs, created_at, updated_at) values (?, ?, ?, 'draft', ?, ?, ?, ?, ?)",
  )
    .bind(versionId, body.campus, version, body.fileName ?? null, objects.length, unresolvedDiffs, createdAt, createdAt)
    .run();

  if (env.SHUMAP_BUCKET) {
    await env.SHUMAP_BUCKET.put(`draft/maps/${versionId}.svg`, body.svgText, {
      httpMetadata: { contentType: "image/svg+xml; charset=utf-8" },
    });
  }

  for (const object of objects) {
    const objectId = makeId("obj");
    await env.DB.prepare(
      "insert into map_objects (id, map_version_id, campus, raw_id, normalized_id, object_kind, label_text, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        objectId,
        versionId,
        body.campus,
        object.rawId,
        object.normalizedId,
        object.kind,
        object.text || null,
        createdAt,
      )
      .run();
  }

  for (const object of added) {
    await env.DB.prepare(
      "insert into svg_diffs (id, map_version_id, diff_type, normalized_id, detail_json, status, created_at) values (?, ?, 'added', ?, ?, 'open', ?)",
    )
      .bind(makeId("diff"), versionId, object.normalizedId, JSON.stringify(object), createdAt)
      .run();
  }
  for (const object of deleted) {
    await env.DB.prepare(
      "insert into svg_diffs (id, map_version_id, diff_type, normalized_id, detail_json, status, created_at) values (?, ?, 'deleted', ?, ?, 'open', ?)",
    )
      .bind(makeId("diff"), versionId, object.normalizedId, JSON.stringify(object), createdAt)
      .run();
  }

  if (unresolvedDiffs > 0) {
    await env.DB.prepare(
      "insert into validation_issues (id, severity, title, detail, target, created_at) values (?, 'warning', ?, ?, ?, ?)",
    )
      .bind(
        makeId("issue"),
        "SVG diff 待确认",
        `${body.campus} ${version} 有 ${unresolvedDiffs} 个新增/删除对象需要确认绑定。`,
        `map:${versionId}`,
        createdAt,
      )
      .run();
  }

  await writeLog(env, "audit", `Imported SVG ${body.fileName || version} for ${body.campus}`, "admin", {
    versionId,
    added: added.length,
    deleted: deleted.length,
  });

  return json({
    id: versionId,
    campus: body.campus,
    version,
    objectCount: objects.length,
    diff: { added: added.length, deleted: deleted.length, matched, changed: 0 },
  });
}

async function createBackup(env: Env) {
  const createdAt = nowIso();
  const backup = {
    createdAt,
    overview: await readOverview(env),
  };
  const key = `backups/${createdAt.replace(/[:.]/g, "-")}.json`;
  const storedInR2 = Boolean(env.SHUMAP_BUCKET);
  if (env.SHUMAP_BUCKET) {
    await env.SHUMAP_BUCKET.put(key, JSON.stringify(backup, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }
  if (env.DB) {
    await env.DB.prepare(
      "insert into backups (id, key, size_bytes, stored_in_r2, created_at) values (?, ?, ?, ?, ?)"
    ).bind(makeId("backup"), key, JSON.stringify(backup).length, storedInR2 ? 1 : 0, createdAt).run();
  }
  await writeLog(env, "audit", "Created manual backup", "admin", { key });
  return json({ key, createdAt, storedInR2 });
}

async function buildReleaseSnapshot(env: Env) {
  if (!env.DB) {
    return {
      schemaVersion: 1,
      generatedAt: nowIso(),
      overview: sampleOverview,
      maps: [],
      mapObjects: [],
      pois: [],
      poiAttributes: [],
      poiAttributeLinks: [],
      poiTags: [],
      poiTagLinks: [],
      poiBindings: [],
      markerTypes: [],
      markers: [],
      routeOverlays: [],
      shuttleRoutes: [],
    };
  }

  const [
    maps,
    mapObjects,
    pois,
    poiAttributes,
    poiAttributeLinks,
    poiBindings,
    markerTypes,
    markers,
    routeOverlays,
    shuttleRoutes,
  ] = await Promise.all([
    env.DB.prepare(
      `select mv.id, mv.campus, mv.version, mv.status,
              mv.source_file_name as sourceFileName,
              mv.object_count as objectCount,
              mv.unresolved_diffs as unresolvedDiffs,
              mv.created_at as createdAt,
              'draft/maps/' || mv.id || '.svg' as svgKey
       from map_versions mv
       where not exists (
         select 1 from map_versions newer
         where newer.campus = mv.campus and newer.created_at > mv.created_at
       )
       order by mv.campus`,
    ).all(),
    env.DB.prepare(
      `select mo.id, mo.map_version_id as mapVersionId, mo.campus,
              mo.raw_id as rawId, mo.normalized_id as normalizedId,
              mo.object_kind as objectKind, mo.label_text as labelText,
              mo.bbox_json as bboxJson
       from map_objects mo
       where mo.map_version_id in (
         select mv.id from map_versions mv
         where not exists (
           select 1 from map_versions newer
           where newer.campus = mv.campus and newer.created_at > mv.created_at
         )
       )
       order by mo.campus, mo.normalized_id`,
    ).all(),
    env.DB.prepare(
      `select id, name, campus, category, geometry, status,
              detail_json as detailJson, navigation_json as navigationJson,
              updated_at as updatedAt
       from pois
       where status != 'hidden'
       order by campus, category, name`,
    ).all(),
    env.DB.prepare(
      "select id, name, color, sort_order as sortOrder from poi_tags order by sort_order asc, name asc",
    ).all(),
    env.DB.prepare(
      "select poi_id as poiId, tag_id as attributeId, tag_id as tagId from poi_tag_links order by poi_id, tag_id",
    ).all(),
    env.DB.prepare(
      `select id, poi_id as poiId, binding_type as bindingType,
              map_object_id as mapObjectId, marker_id as markerId,
              geometry_json as geometryJson
       from poi_bindings
       order by created_at`,
    ).all(),
    env.DB.prepare(
      `select id, name, icon, color, visibility,
              default_poi_category as defaultPoiCategory,
              default_attribute_ids as defaultAttributeIds,
              default_display_mode as defaultDisplayMode,
              creates_poi as createsPoi
       from marker_types
       order by name`,
    ).all(),
    env.DB.prepare(
      `select id, marker_type_id as markerTypeId, campus, poi_id as poiId,
              parent_poi_id as parentPoiId, parent_space_id as parentSpaceId,
              floor_id as floorId, location_hint as locationHint,
              display_mode as displayMode, indoor_position_json as indoorPositionJson,
              x, y, status, meta_json as metaJson
       from markers
       where status != 'hidden'
       order by campus, marker_type_id`,
    ).all(),
    env.DB.prepare(
      `select id, name, campus, kind, status,
              geometry_json as geometryJson, style_json as styleJson
       from route_overlays
       where status != 'hidden'
       order by campus, kind, name`,
    ).all(),
    env.DB.prepare(
      `select id, from_campus as "from", to_campus as "to",
              weekday_trips as weekdayTrips, weekend_trips as weekendTrips,
              schedule_json as scheduleJson, updated_at as updatedAt
       from shuttle_routes
       order by id`,
    ).all(),
  ]);

  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    overview: await readOverview(env),
    maps: maps.results,
    mapObjects: mapObjects.results,
    pois: pois.results,
    poiAttributes: poiAttributes.results,
    poiAttributeLinks: poiAttributeLinks.results,
    poiTags: poiAttributes.results,
    poiTagLinks: poiAttributeLinks.results,
    poiBindings: poiBindings.results,
    markerTypes: markerTypes.results,
    markers: markers.results,
    routeOverlays: routeOverlays.results,
    shuttleRoutes: shuttleRoutes.results,
  };
}

async function readCurrentReleaseSnapshot(env: Env) {
  if (!env.RELEASE_KV || !env.SHUMAP_BUCKET) {
    return json({ error: "Release storage is not enabled" }, { status: 503 });
  }
  const current = await env.RELEASE_KV.get("current_release");
  if (!current) return notFound();
  const currentRelease = JSON.parse(current) as { snapshotKey?: string };
  if (!currentRelease.snapshotKey) return notFound();
  const snapshotObject = await env.SHUMAP_BUCKET.get(currentRelease.snapshotKey);
  if (!snapshotObject) return notFound();
  return new Response(await snapshotObject.text(), { headers: JSON_HEADERS });
}

async function createPoi(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{
    id: string;
    name: string;
    campus: string;
    category: string;
    geometry: string;
    status: string;
    detail: unknown;
    navigation: unknown;
    attributeIds: string[];
    tagIds: string[];
  }>(request);
  if (!body.name || !body.campus || !body.category) {
    return json({ error: "name, campus and category are required" }, { status: 400 });
  }
  const id = body.id || makeId("poi");
  const now = nowIso();
  await env.DB.prepare(
    "insert into pois (id, name, campus, category, geometry, status, detail_json, navigation_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      body.name,
      body.campus,
      body.category,
      body.geometry || "none",
      body.status || "draft",
      JSON.stringify(body.detail ?? {}),
      JSON.stringify(body.navigation ?? null),
      now,
      now,
    )
    .run();
  await replacePoiAttributes(env, id, body.attributeIds ?? body.tagIds, now);
  await writeLog(env, "audit", `Created POI ${body.name}`, "admin", { id });
  return json({ ok: true, id });
}

async function updatePoi(request: Request, env: Env, id: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{
    name: string;
    campus: string;
    category: string;
    geometry: string;
    status: string;
    detail: unknown;
    navigation: unknown;
    attributeIds: string[];
    tagIds: string[];
  }>(request);
  const current = await env.DB.prepare("select * from pois where id = ?").bind(id).first<Record<string, unknown>>();
  if (!current) return notFound();
  await env.DB.prepare(
    "update pois set name = ?, campus = ?, category = ?, geometry = ?, status = ?, detail_json = ?, navigation_json = ?, updated_at = ? where id = ?",
  )
    .bind(
      body.name ?? current.name,
      body.campus ?? current.campus,
      body.category ?? current.category,
      body.geometry ?? current.geometry,
      body.status ?? current.status,
      JSON.stringify(body.detail ?? JSON.parse(String(current.detail_json || "{}"))),
      JSON.stringify(body.navigation ?? JSON.parse(String(current.navigation_json || "null"))),
      nowIso(),
      id,
    )
    .run();
  await replacePoiAttributes(env, id, body.attributeIds ?? body.tagIds);
  await writeLog(env, "audit", `Updated POI ${id}`, "admin");
  return json({ ok: true, id });
}

async function createPoiTag(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{ id: string; name: string; color: string; sortOrder: number }>(request);
  if (!body.name) return json({ error: "name is required" }, { status: 400 });
  const id = (body.id || body.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || makeId("tag");
  const now = nowIso();
  await env.DB.prepare(
    "insert into poi_tags (id, name, color, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
  ).bind(id, body.name.trim(), body.color || "#1E80C1", Number(body.sortOrder) || 100, now, now).run();
  await writeLog(env, "audit", `Created POI tag ${body.name}`, "admin");
  return json({ ok: true, id });
}

async function updatePoiTag(request: Request, env: Env, id: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{ name: string; color: string; sortOrder: number }>(request);
  const current = await env.DB.prepare("select id from poi_tags where id = ?").bind(id).first();
  if (!current) return notFound();
  await env.DB.prepare(
    "update poi_tags set name = coalesce(?, name), color = coalesce(?, color), sort_order = coalesce(?, sort_order), updated_at = ? where id = ?",
  ).bind(body.name?.trim() || null, body.color || null, body.sortOrder ?? null, nowIso(), id).run();
  await writeLog(env, "audit", `Updated POI tag ${id}`, "admin");
  return json({ ok: true, id });
}

async function deletePoiTag(env: Env, id: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const used = await env.DB.prepare("select count(*) as count from poi_tag_links where tag_id = ?")
    .bind(id)
    .first<{ count: number }>();
  if ((used?.count ?? 0) > 0) {
    return json({ error: "This tag is used by POIs and cannot be deleted." }, { status: 409 });
  }
  await env.DB.prepare("delete from poi_tags where id = ?").bind(id).run();
  await writeLog(env, "audit", `Deleted POI tag ${id}`, "admin");
  return json({ ok: true, id });
}

function tryParseJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function computeSubmissionDiff(currentDetail: Record<string, unknown>, currentAttributeIds: string[], content: Record<string, unknown>) {
  const nextDetail = (content.detail && typeof content.detail === "object" ? content.detail : {}) as Record<string, unknown>;
  const nextAttributeIds = Array.isArray(content.attributeIds)
    ? content.attributeIds.map(String)
    : Array.isArray(content.tagIds) ? content.tagIds.map(String) : [];
  const changedFields = Object.keys(nextDetail).filter((key) => {
    return JSON.stringify(currentDetail[key] ?? null) !== JSON.stringify(nextDetail[key] ?? null);
  });
  const addedAttributes = nextAttributeIds.filter((attributeId) => !currentAttributeIds.includes(attributeId));
  const removedAttributes = currentAttributeIds.filter((attributeId) => nextAttributeIds.length > 0 && !nextAttributeIds.includes(attributeId));
  return { changedFields, addedAttributes, removedAttributes };
}

async function createPoiContentSubmission(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{
    poiId: string;
    poiName: string;
    campus: string;
    submitterName: string;
    submitterContact: string;
    content: Record<string, unknown>;
  }>(request);
  if (!body.poiId && !body.poiName) {
    return json({ error: "poiId or poiName is required" }, { status: 400 });
  }
  if (!body.content || typeof body.content !== "object") {
    return json({ error: "content is required" }, { status: 400 });
  }
  const current = body.poiId
    ? await env.DB.prepare("select id, name, campus, detail_json as detailJson from pois where id = ?").bind(body.poiId).first<{
      id: string;
      name: string;
      campus: string;
      detailJson: string | null;
    }>()
    : null;
  const currentDetail = (tryParseJson(current?.detailJson, {}) || {}) as Record<string, unknown>;
  const currentAttributeIds = current?.id ? await readPoiAttributeIds(env, current.id) : [];
  const diff = computeSubmissionDiff(currentDetail, currentAttributeIds, body.content);
  const id = makeId("submission");
  const now = nowIso();
  await env.DB.prepare(
    `insert into poi_content_submissions
      (id, poi_id, poi_name, campus, submitter_name, submitter_contact, content_json, diff_json, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(
    id,
    current?.id ?? body.poiId ?? null,
    current?.name ?? body.poiName ?? null,
    current?.campus ?? body.campus ?? null,
    body.submitterName ?? null,
    body.submitterContact ?? null,
    JSON.stringify(body.content),
    JSON.stringify(diff),
    now,
  ).run();
  await writeLog(env, "info", `Received POI content submission ${id}`, "public", { poiId: current?.id ?? body.poiId ?? null });
  return json({ ok: true, id });
}

async function readPoiContentSubmissions(env: Env, url: URL) {
  if (!env.DB) return [];
  const status = url.searchParams.get("status") || "pending";
  const result = await env.DB.prepare(
    `select pcs.id, pcs.poi_id as poiId, coalesce(p.name, pcs.poi_name) as poiName,
            coalesce(p.campus, pcs.campus) as campus,
            pcs.submitter_name as submitterName, pcs.submitter_contact as submitterContact,
            pcs.content_json as contentJson, pcs.diff_json as diffJson,
            pcs.status, pcs.created_at as createdAt, pcs.reviewed_at as reviewedAt,
            pcs.reviewed_by as reviewedBy
     from poi_content_submissions pcs
     left join pois p on p.id = pcs.poi_id
     where (? = 'all' or pcs.status = ?)
     order by pcs.created_at desc
     limit 100`,
  ).bind(status, status).all();
  return result.results;
}

async function reviewPoiContentSubmission(request: Request, env: Env, id: string, reviewer: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{ status: "approved" | "rejected"; content: Record<string, unknown> }>(request);
  const submission = await env.DB.prepare(
    "select id, poi_id as poiId, content_json as contentJson, status from poi_content_submissions where id = ?",
  ).bind(id).first<{ id: string; poiId: string | null; contentJson: string; status: string }>();
  if (!submission) return notFound();
  if (submission.status !== "pending") return json({ error: "submission has already been reviewed" }, { status: 409 });

  const now = nowIso();
  if (body.status === "rejected") {
    await env.DB.prepare(
      "update poi_content_submissions set status = 'rejected', reviewed_at = ?, reviewed_by = ? where id = ?",
    ).bind(now, reviewer, id).run();
    await writeLog(env, "audit", `Rejected POI content submission ${id}`, reviewer);
    return json({ ok: true, id, status: "rejected" });
  }

  if (!submission.poiId) return json({ error: "submission is not linked to an existing POI" }, { status: 400 });
  const content = body.content && typeof body.content === "object"
    ? body.content
    : (tryParseJson(submission.contentJson, {}) as Record<string, unknown>);
  const current = await env.DB.prepare("select detail_json as detailJson from pois where id = ?")
    .bind(submission.poiId)
    .first<{ detailJson: string | null }>();
  const currentDetail = (tryParseJson(current?.detailJson, {}) || {}) as Record<string, unknown>;
  const submittedDetail = (content.detail && typeof content.detail === "object" ? content.detail : {}) as Record<string, unknown>;
  const nextDetail = { ...currentDetail, ...submittedDetail };
  const attributeIds = Array.isArray(content.attributeIds)
    ? content.attributeIds.map(String)
    : Array.isArray(content.tagIds) ? content.tagIds.map(String) : undefined;

  await env.DB.prepare("update pois set detail_json = ?, updated_at = ? where id = ?")
    .bind(JSON.stringify(nextDetail), now, submission.poiId)
    .run();
  await replacePoiAttributes(env, submission.poiId, attributeIds, now);
  await env.DB.prepare(
    "update poi_content_submissions set status = 'approved', reviewed_at = ?, reviewed_by = ? where id = ?",
  ).bind(now, reviewer, id).run();
  await writeLog(env, "audit", `Approved POI content submission ${id}`, reviewer, { poiId: submission.poiId });
  return json({ ok: true, id, status: "approved" });
}

async function uploadMedia(request: Request, env: Env, actor: string, defaultPrefix: string) {
  if (!env.SHUMAP_BUCKET) return json({ error: "R2 is not enabled. Enable R2 in Cloudflare Dashboard first." }, { status: 503 });
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Use multipart/form-data" }, { status: 400 });
  }
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json({ error: "No file provided" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return json({ error: "Only image files are allowed" }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return json({ error: "Image must be smaller than 8 MB" }, { status: 400 });
    }
    const rawPrefix = String(formData.get("prefix") || defaultPrefix);
    const prefix = rawPrefix.replace(/[^a-zA-Z0-9/_-]/g, "") || defaultPrefix;
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${prefix}/${Date.now()}_${safeName}`;
    await env.SHUMAP_BUCKET.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    await writeLog(env, "audit", `Uploaded media: ${key}`, actor);
    return json({ ok: true, key, url: `/api/media/file?key=${encodeURIComponent(key)}`, size: file.size, contentType: file.type });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 500 });
  }
}

async function createPoiCategory(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{ id: string; name: string; sortOrder: number }>(request);
  if (!body.id || !body.name) {
    return json({ error: "id and name are required" }, { status: 400 });
  }
  const id = body.id.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return json({ error: "id must use lowercase letters, numbers and hyphens" }, { status: 400 });
  }
  const now = nowIso();
  await env.DB.prepare(
    "insert into poi_categories (id, name, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?)",
  ).bind(id, body.name.trim(), Number(body.sortOrder) || 100, now, now).run();
  await writeLog(env, "audit", `Created POI category ${id}`, "admin");
  return json({ ok: true, id });
}

async function updatePoiCategory(request: Request, env: Env, id: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{ name: string; sortOrder: number }>(request);
  const current = await env.DB.prepare("select id, name, sort_order as sortOrder from poi_categories where id = ?").bind(id).first<Record<string, unknown>>();
  if (!current) return notFound();
  const now = nowIso();
  await env.DB.prepare(
    "update poi_categories set name = ?, sort_order = ?, updated_at = ? where id = ?",
  ).bind(body.name ?? current.name, Number(body.sortOrder ?? current.sortOrder) || 100, now, id).run();
  await writeLog(env, "audit", `Updated POI category ${id}`, "admin");
  return json({ ok: true, id });
}

async function deletePoiCategory(env: Env, id: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const usage = await env.DB.prepare("select count(*) as count from pois where category = ?").bind(id).first<{ count: number }>();
  if ((usage?.count ?? 0) > 0) {
    return json({ error: "This category is still used by POIs" }, { status: 409 });
  }
  await env.DB.prepare("delete from poi_categories where id = ?").bind(id).run();
  await writeLog(env, "audit", `Deleted POI category ${id}`, "admin");
  return json({ ok: true, id });
}

async function createMarkerType(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{
    id: string;
    name: string;
    icon: string;
    color: string;
    visibility: string;
    defaultPoiCategory: string;
    defaultAttributeIds: string;
    defaultDisplayMode: string;
    createsPoi: boolean | number;
  }>(request);
  if (!body.name || !body.icon) {
    return json({ error: "name and icon are required" }, { status: 400 });
  }
  const id = body.id || makeId("marker_type");
  const now = nowIso();
  await env.DB.prepare(
    `insert into marker_types
      (id, name, icon, color, visibility, default_poi_category, default_attribute_ids, default_display_mode, creates_poi, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.name,
      body.icon,
      body.color || "#1E80C1",
      body.visibility || "on-filter",
      body.defaultPoiCategory || "service",
      body.defaultAttributeIds || null,
      body.defaultDisplayMode || "standalone",
      body.createsPoi === false || body.createsPoi === 0 ? 0 : 1,
      now,
      now,
    )
    .run();
  await writeLog(env, "audit", `Created marker type ${body.name}`, "admin", { id });
  return json({ ok: true, id });
}

async function updateMarkerType(request: Request, env: Env, id: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{
    name: string;
    icon: string;
    color: string;
    visibility: string;
    defaultPoiCategory: string;
    defaultAttributeIds: string;
    defaultDisplayMode: string;
    createsPoi: boolean | number;
  }>(request);
  const current = await env.DB.prepare("select * from marker_types where id = ?").bind(id).first<Record<string, unknown>>();
  if (!current) return notFound();
  const now = nowIso();
  await env.DB.prepare(
    `update marker_types
     set name = ?, icon = ?, color = ?, visibility = ?,
         default_poi_category = ?, default_attribute_ids = ?,
         default_display_mode = ?, creates_poi = ?, updated_at = ?
     where id = ?`,
  ).bind(
    body.name ?? current.name,
    body.icon ?? current.icon,
    body.color ?? current.color ?? "#1E80C1",
    body.visibility ?? current.visibility ?? "on-filter",
    body.defaultPoiCategory ?? current.default_poi_category ?? "service",
    body.defaultAttributeIds ?? current.default_attribute_ids ?? null,
    body.defaultDisplayMode ?? current.default_display_mode ?? "standalone",
    body.createsPoi === undefined ? current.creates_poi ?? 1 : body.createsPoi === false || body.createsPoi === 0 ? 0 : 1,
    now,
    id,
  ).run();
  await writeLog(env, "audit", `Updated marker type ${id}`, "admin");
  return json({ ok: true, id });
}

async function createMarker(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{
    id: string;
    markerTypeId: string;
    campus: string;
    poiId: string;
    parentPoiId: string;
    parentSpaceId: string;
    floorId: string;
    locationHint: string;
    displayMode: string;
    indoorPosition: unknown;
    x: number;
    y: number;
    status: string;
    meta: unknown;
  }>(request);
  if (!body.markerTypeId || !body.campus || typeof body.x !== "number" || typeof body.y !== "number") {
    return json({ error: "markerTypeId, campus, x and y are required" }, { status: 400 });
  }
  const id = body.id || makeId("marker");
  const now = nowIso();
  const statements = [
    env.DB.prepare(
      `insert into markers
        (id, marker_type_id, campus, poi_id, parent_poi_id, parent_space_id, floor_id,
         location_hint, display_mode, indoor_position_json, x, y, status, meta_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      body.markerTypeId,
      body.campus,
      body.poiId || null,
      body.parentPoiId || null,
      body.parentSpaceId || null,
      body.floorId || null,
      body.locationHint || null,
      body.displayMode || (body.parentPoiId ? "attached" : "standalone"),
      JSON.stringify(body.indoorPosition ?? null),
      body.x,
      body.y,
      body.status || "draft",
      JSON.stringify(body.meta ?? {}),
      now,
      now,
    ),
  ];
  if (body.poiId) {
    const bindingId = makeId("bind");
    statements.push(
      env.DB.prepare(
        "update markers set poi_id = null, updated_at = ? where id in (select marker_id from poi_bindings where poi_id = ? and marker_id is not null)"
      ).bind(now, body.poiId),
      env.DB.prepare("delete from poi_bindings where poi_id = ?").bind(body.poiId),
      env.DB.prepare(
        "insert into poi_bindings (id, poi_id, binding_type, map_object_id, marker_id, geometry_json, created_at) values (?, ?, 'marker', null, ?, null, ?)"
      ).bind(bindingId, body.poiId, id, now),
      env.DB.prepare("update pois set geometry = 'marker', status = case when status = 'issue' then 'draft' else status end, updated_at = ? where id = ?")
        .bind(now, body.poiId),
    );
  }
  await env.DB.batch(statements);
  await writeLog(env, "audit", `Created marker ${id}`, "admin");
  return json({ ok: true, id });
}

async function updateMarker(request: Request, env: Env, id: string) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const current = await env.DB.prepare(
    `select id, marker_type_id as markerTypeId, campus, poi_id as poiId,
            parent_poi_id as parentPoiId, parent_space_id as parentSpaceId,
            floor_id as floorId, location_hint as locationHint,
            display_mode as displayMode, indoor_position_json as indoorPositionJson,
            x, y, status, meta_json as metaJson
     from markers where id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      markerTypeId: string;
      campus: string;
      poiId: string | null;
      parentPoiId: string | null;
      parentSpaceId: string | null;
      floorId: string | null;
      locationHint: string | null;
      displayMode: string | null;
      indoorPositionJson: string | null;
      x: number;
      y: number;
      status: string;
      metaJson: string | null;
    }>();
  if (!current) return notFound();
  const body = await parseJsonBody<{
    markerTypeId: string;
    campus: string;
    poiId: string | null;
    parentPoiId: string | null;
    parentSpaceId: string | null;
    floorId: string | null;
    locationHint: string | null;
    displayMode: string;
    indoorPosition: unknown;
    x: number;
    y: number;
    status: string;
    meta: unknown;
  }>(request);
  const nextPoiId = body.poiId ?? null;
  const now = nowIso();
  const statements = [
    env.DB.prepare(
      `update markers
       set marker_type_id = ?, campus = ?, poi_id = ?, parent_poi_id = ?,
           parent_space_id = ?, floor_id = ?, location_hint = ?,
           display_mode = ?, indoor_position_json = ?,
           x = ?, y = ?, status = ?, meta_json = ?, updated_at = ?
       where id = ?`
    ).bind(
      body.markerTypeId ?? current.markerTypeId,
      body.campus ?? current.campus,
      nextPoiId,
      body.parentPoiId === undefined ? current.parentPoiId : body.parentPoiId || null,
      body.parentSpaceId === undefined ? current.parentSpaceId : body.parentSpaceId || null,
      body.floorId === undefined ? current.floorId : body.floorId || null,
      body.locationHint === undefined ? current.locationHint : body.locationHint || null,
      body.displayMode ?? current.displayMode ?? "standalone",
      JSON.stringify(body.indoorPosition ?? JSON.parse(current.indoorPositionJson || "null")),
      typeof body.x === "number" ? body.x : current.x,
      typeof body.y === "number" ? body.y : current.y,
      body.status ?? current.status,
      JSON.stringify(body.meta ?? JSON.parse(current.metaJson || "{}")),
      now,
      id,
    ),
  ];

  if (current.poiId && current.poiId !== nextPoiId) {
    statements.push(
      env.DB.prepare("delete from poi_bindings where poi_id = ? and marker_id = ?").bind(current.poiId, id),
      env.DB.prepare("update pois set geometry = 'none', status = case when status = 'draft' then 'issue' else status end, updated_at = ? where id = ? and not exists (select 1 from poi_bindings where poi_id = ? and marker_id != ?)")
        .bind(now, current.poiId, current.poiId, id),
    );
  }

  if (nextPoiId && current.poiId !== nextPoiId) {
    const bindingId = makeId("bind");
    statements.push(
      env.DB.prepare(
        "update markers set poi_id = null, updated_at = ? where id in (select marker_id from poi_bindings where poi_id = ? and marker_id is not null)"
      ).bind(now, nextPoiId),
      env.DB.prepare("delete from poi_bindings where poi_id = ?").bind(nextPoiId),
      env.DB.prepare(
        "insert into poi_bindings (id, poi_id, binding_type, map_object_id, marker_id, geometry_json, created_at) values (?, ?, 'marker', null, ?, null, ?)"
      ).bind(bindingId, nextPoiId, id, now),
      env.DB.prepare("update pois set geometry = 'marker', status = case when status = 'issue' then 'draft' else status end, updated_at = ? where id = ?")
        .bind(now, nextPoiId),
    );
  }

  await env.DB.batch(statements);
  await writeLog(env, "audit", `Updated marker ${id}`, "admin");
  return json({ ok: true, id });
}

async function recordAnalyticsEvent(request: Request, env: Env) {
  if (!env.DB) return json({ ok: true, recorded: false });
  const body = await parseJsonBody<{
    eventType: string;
    campus: string;
    poiId: string;
    poiName: string;
    meta: unknown;
  }>(request);
  const eventType = String(body.eventType || "").slice(0, 64);
  if (!eventType) return json({ error: "eventType is required" }, { status: 400 });
  await env.DB.prepare(
    "insert into analytics_events (id, event_type, campus, poi_id, poi_name, meta_json, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      makeId("event"),
      eventType,
      body.campus || null,
      body.poiId || null,
      body.poiName || null,
      JSON.stringify(body.meta ?? null),
      nowIso(),
    )
    .run();
  return json({ ok: true, recorded: true });
}

async function upsertShuttleRoute(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{
    id: string;
    from: string;
    to: string;
    weekdayTrips: number;
    weekendTrips: number;
    schedule: unknown;
  }>(request);
  if (!body.id || !body.from || !body.to) {
    return json({ error: "id, from and to are required" }, { status: 400 });
  }
  await env.DB.prepare(
    "insert into shuttle_routes (id, from_campus, to_campus, weekday_trips, weekend_trips, schedule_json, updated_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set from_campus = excluded.from_campus, to_campus = excluded.to_campus, weekday_trips = excluded.weekday_trips, weekend_trips = excluded.weekend_trips, schedule_json = excluded.schedule_json, updated_at = excluded.updated_at",
  )
    .bind(
      body.id,
      body.from,
      body.to,
      body.weekdayTrips ?? 0,
      body.weekendTrips ?? 0,
      JSON.stringify(body.schedule ?? {}),
      nowIso(),
    )
    .run();
  await writeLog(env, "audit", `Saved shuttle route ${body.id}`, "admin");
  return json({ ok: true, id: body.id });
}

async function createAdmin(request: Request, env: Env) {
  if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
  const body = await parseJsonBody<{ email: string; displayName: string; password: string }>(request);
  if (!body.email) return json({ error: "email is required" }, { status: 400 });
  const existing = await env.DB.prepare("select id from admins where email = ?").bind(body.email).first();
  if (existing) return json({ error: "Admin with this email already exists" }, { status: 409 });
  const id = makeId("admin");
  const now = nowIso();
  const passwordHash = body.password ? await hashPassword(body.password) : null;
  await env.DB.prepare(
    "insert into admins (id, email, display_name, password_hash, status, created_at, updated_at) values (?, ?, ?, ?, 'active', ?, ?)",
  )
    .bind(id, body.email, body.displayName || body.email, passwordHash, now, now)
    .run();
  await writeLog(env, "audit", `Created admin ${body.email}`, "admin", { id });
  return json({ ok: true, id, email: body.email });
}

async function publishRelease(env: Env) {
  if (!env.SHUMAP_BUCKET) return json({ error: "R2 is not enabled" }, { status: 503 });
  if (!env.RELEASE_KV) return json({ error: "Release KV is not enabled" }, { status: 503 });

  const openDiffs = env.DB
    ? await env.DB.prepare("select count(*) as count from svg_diffs where status = 'open'").first<{ count: number }>()
    : { count: 0 };
  if ((openDiffs?.count ?? 0) > 0) {
    return json({ error: `There are ${openDiffs?.count} unresolved SVG diffs.` }, { status: 409 });
  }

  const snapshot = await buildReleaseSnapshot(env);
  const version = `v${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  const releaseId = makeId("release");
  const snapshotKey = `published/${version}/manifest.json`;
  const releaseSnapshot = { releaseId, version, createdAt: nowIso(), ...snapshot };

  await env.SHUMAP_BUCKET.put(snapshotKey, JSON.stringify(releaseSnapshot, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await env.RELEASE_KV.put("current_release", JSON.stringify({ releaseId, version, snapshotKey }));
  if (env.DB) {
    await env.DB.prepare("update releases set status = 'rolled-back' where status = 'published'").run();
    await env.DB.prepare("update map_versions set status = 'archived' where status = 'published'").run();
    await env.DB.prepare(
      `update map_versions
       set status = 'published', updated_at = ?
       where not exists (
         select 1 from map_versions newer
         where newer.campus = map_versions.campus and newer.created_at > map_versions.created_at
       )`,
    ).bind(nowIso()).run();
    await env.DB.prepare(
      "insert into releases (id, version, status, snapshot_key, summary, created_at) values (?, ?, 'published', ?, ?, ?)",
    )
      .bind(releaseId, version, snapshotKey, "Published from admin console", nowIso())
      .run();
  }
  await writeLog(env, "audit", `Published release ${version}`, "admin", { snapshotKey });
  return json({ releaseId, version, snapshotKey });
}

async function requireAuthResponse(request: Request, env: Env): Promise<{ email: string } | Response> {
  if (!getTokenSecret(env)) {
    return json({ error: "ADMIN_TOKEN_SECRET is not configured" }, { status: 503 });
  }
  const auth = await requireAuth(request, env);
  if (!auth) return json({ error: "Unauthorized" }, { status: 401 });
  return auth;
}

async function routeApi(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const [, , resource, id] = path.split("/");

  if (path === "/api/health") {
    return json({ ok: true, bindings: { d1: Boolean(env.DB), r2: Boolean(env.SHUMAP_BUCKET), kv: Boolean(env.RELEASE_KV) } });
  }
  // --- Rate limit check ---
  const rateCheck = await checkRateLimit(env, request, path);
  if (!rateCheck.allowed) {
    return json(
      { error: "Rate limit exceeded", retryAfter: rateCheck.retryAfter },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateCheck.retryAfter),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

  // --- Auth routes (unprotected) ---
  if (path === "/api/auth/login" && request.method === "POST") {
    const tokenSecret = getTokenSecret(env);
    if (!tokenSecret) {
      return json({ error: "ADMIN_TOKEN_SECRET is not configured" }, { status: 503 });
    }
    const body = await parseJsonBody<{ email: string; password: string }>(request);
    if (!body.email || !body.password) {
      return json({ error: "email and password are required" }, { status: 400 });
    }
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const admin = await env.DB.prepare("select id, email, password_hash, display_name from admins where email = ? and status = 'active'")
      .bind(body.email).first<{ id: string; email: string; password_hash: string; display_name: string }>();
    if (!admin || !admin.password_hash) {
      return json({ error: "Invalid email or password" }, { status: 401 });
    }
    const pwValid = await verifyPassword(body.password, admin.password_hash);
    if (!pwValid) {
      return json({ error: "Invalid email or password" }, { status: 401 });
    }
    const token = await createToken({ email: admin.email, sub: admin.id, displayName: admin.display_name }, tokenSecret);
    await writeLog(env, "audit", `Admin login: ${admin.email}`, admin.email);
    return json({ token, email: admin.email, displayName: admin.display_name });
  }

  if (path === "/api/auth/verify" && request.method === "GET") {
    const auth = await requireAuthResponse(request, env);
    if (auth instanceof Response) return auth;
    return json({ email: auth.email });
  }

  if (path === "/api/auth/needs-setup" && request.method === "GET") {
    if (!env.DB) return json({ needsSetup: true });
    const existing = await env.DB.prepare(
      "select count(*) as count from admins where password_hash is not null and status = 'active'"
    ).first<{ count: number }>();
    return json({ needsSetup: !existing || existing.count === 0 });
  }

  if (path === "/api/auth/setup" && request.method === "POST") {
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const existing = await env.DB.prepare(
      "select count(*) as count from admins where password_hash is not null and status = 'active'"
    ).first<{ count: number }>();
    if (existing && existing.count > 0) {
      return json({ error: "Setup already completed. Log in or use the admin panel to add accounts." }, { status: 403 });
    }
    const body = await parseJsonBody<{ email: string; password: string }>(request);
    if (!body.email || !body.password) {
      return json({ error: "email and password are required" }, { status: 400 });
    }
    const passwordHash = await hashPassword(body.password);
    const id = makeId("admin");
    const now = nowIso();
    await env.DB.prepare(
      "insert into admins (id, email, display_name, password_hash, status, created_at, updated_at) values (?, ?, ?, ?, 'active', ?, ?)",
    )
      .bind(id, body.email, body.email, passwordHash, now, now)
      .run();
    await writeLog(env, "audit", `Initial admin setup completed: ${body.email}`, "setup");
    return json({ ok: true, id, email: body.email, message: "Initial admin created. You can now log in." });
  }

  if (path === "/api/public/release/current" && request.method === "GET") {
    return readCurrentReleaseSnapshot(env);
  }
  if (path === "/api/public/pois" && request.method === "GET") {
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const result = await env.DB.prepare(
      "select id, name, campus, category from pois where status != 'hidden' order by campus, name limit 1000",
    ).all();
    return json(result.results);
  }
  if ((path === "/api/public/poi-attributes" || path === "/api/public/poi-tags") && request.method === "GET") {
    return json(await readPoiAttributes(env));
  }
  if (path === "/api/public/media/upload" && request.method === "POST") {
    return uploadMedia(request, env, "public", "submissions");
  }
  if (path === "/api/public/poi-content-submissions" && request.method === "POST") {
    return createPoiContentSubmission(request, env);
  }
  if (path === "/api/media/file" && request.method === "GET") {
    if (!env.SHUMAP_BUCKET) return json({ error: "R2 is not enabled" }, { status: 503 });
    const key = url.searchParams.get("key");
    if (!key) return json({ error: "key is required" }, { status: 400 });
    const object = await env.SHUMAP_BUCKET.get(key);
    if (!object) return notFound();
    return new Response(await object.arrayBuffer(), {
      headers: {
        "content-type": object.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  if (path === "/api/analytics/events" && request.method === "POST") {
    return recordAnalyticsEvent(request, env);
  }

  // --- Protected routes ---
  const auth = await requireAuthResponse(request, env);
  if (auth instanceof Response) return auth;

  if (path === "/api/admin/overview" && request.method === "GET") {
    return json(await readOverview(env));
  }
  if (path === "/api/admin/usage" && request.method === "GET") {
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const [tableCounts, recentRateLimits, logCounts, todayEvents, todayPoiViews, topPois] = await Promise.all([
      env.DB.prepare(`
        select 'pois' as tbl, count(*) as count from pois union all
        select 'markers', count(*) from markers union all
        select 'map_versions', count(*) from map_versions union all
        select 'shuttle_routes', count(*) from shuttle_routes union all
        select 'logs', count(*) from logs union all
        select 'rate_limits', count(*) from rate_limits
      `).all(),
      env.DB.prepare(
        "select key, count, window_start, updated_at from rate_limits where count > 5 order by count desc limit 10"
      ).all(),
      env.DB.prepare(
        "select level, count(*) as count from logs where created_at > datetime('now', '-24 hours') group by level"
      ).all(),
      env.DB.prepare(
        "select count(*) as count from analytics_events where created_at > datetime('now', '-24 hours')"
      ).first<{ count: number }>(),
      env.DB.prepare(
        "select count(*) as count from analytics_events where event_type = 'poi_view' and created_at > datetime('now', '-24 hours')"
      ).first<{ count: number }>(),
      env.DB.prepare(
        `select coalesce(poi_name, poi_id, '未知点位') as name,
                poi_id as poiId,
                campus,
                count(*) as count
         from analytics_events
         where event_type = 'poi_view'
           and created_at > datetime('now', '-7 days')
         group by coalesce(poi_id, poi_name), campus
         order by count desc
         limit 8`
      ).all(),
    ]);
    return json({
      tableCounts: tableCounts.results,
      recentRateLimits: recentRateLimits.results,
      logCounts24h: logCounts.results,
      analytics: {
        todayEvents: todayEvents?.count ?? 0,
        todayPoiViews: todayPoiViews?.count ?? 0,
        estimatedTrafficKb: Math.round((todayEvents?.count ?? 0) * 1.4),
        topPois: topPois.results,
      },
      limits: {
        loginPerMinute: 10,
        adminPerMinute: 120,
        defaultPerMinute: 300,
      },
    });
  }
  if (path === "/api/map-versions/import" && request.method === "POST") {
    return importSvg(request, env);
  }
  if (path === "/api/map-objects" && request.method === "GET") return json(await readMapObjectsForAdmin(env, url));
  if (path === "/api/poi-categories" && request.method === "GET") return json(await readPoiCategories(env));
  if (path === "/api/poi-categories" && request.method === "POST") return createPoiCategory(request, env);
  if (resource === "poi-categories" && id && request.method === "PATCH") return updatePoiCategory(request, env, id);
  if (resource === "poi-categories" && id && request.method === "DELETE") return deletePoiCategory(env, id);
  if ((path === "/api/poi-attributes" || path === "/api/poi-tags") && request.method === "GET") return json(await readPoiAttributes(env));
  if ((path === "/api/poi-attributes" || path === "/api/poi-tags") && request.method === "POST") return createPoiTag(request, env);
  if ((resource === "poi-attributes" || resource === "poi-tags") && id && request.method === "PATCH") return updatePoiTag(request, env, id);
  if ((resource === "poi-attributes" || resource === "poi-tags") && id && request.method === "DELETE") return deletePoiTag(env, id);
  if (path === "/api/poi-content-submissions" && request.method === "GET") return json(await readPoiContentSubmissions(env, url));
  if (resource === "poi-content-submissions" && id && request.method === "PATCH") {
    return reviewPoiContentSubmission(request, env, id, auth.email);
  }
  if (path === "/api/pois" && request.method === "GET") return json(await readAdminPois(env));
  if (path === "/api/pois" && request.method === "POST") return createPoi(request, env);
  if (resource === "pois" && id && request.method === "GET" && !path.endsWith("/bindings")) {
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const poi = await env.DB.prepare(
      `select p.id, p.name, p.campus, p.category, p.geometry, p.status,
              p.detail_json as detailJson, p.navigation_json as navigationJson,
              p.created_at as createdAt, p.updated_at as updatedAt,
              primary_binding.binding_type as primaryBindingType,
              primary_binding.map_object_id as primaryMapObjectId,
              primary_object.raw_id as primaryMapObjectRawId,
              primary_object.normalized_id as primaryMapObjectNormalizedId,
              primary_object.bbox_json as primaryMapObjectBBoxJson,
              primary_binding.marker_id as primaryMarkerId,
              primary_marker.x as primaryMarkerX,
              primary_marker.y as primaryMarkerY
       from pois p
       left join poi_bindings primary_binding on primary_binding.poi_id = p.id
         and primary_binding.id = (
           select pb2.id from poi_bindings pb2 where pb2.poi_id = p.id order by pb2.created_at desc limit 1
         )
       left join map_objects primary_object on primary_object.id = primary_binding.map_object_id
       left join markers primary_marker on primary_marker.id = primary_binding.marker_id
       where p.id = ?`,
    ).bind(id).first();
    if (!poi) return notFound();
    const attributeIds = await readPoiAttributeIds(env, id);
    return json({ ...(poi as Record<string, unknown>), attributeIds, tagIds: attributeIds });
  }
  if (resource === "pois" && id && request.method === "PATCH") return updatePoi(request, env, id);
  if (resource === "pois" && id && request.method === "DELETE") return deleteById(env, "pois", id);
  if (resource === "pois" && request.method === "GET" && path.endsWith("/bindings")) {
    // GET /api/pois/:id/bindings
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const bindings = await env.DB.prepare(
      `select pb.id, pb.poi_id as poiId, pb.binding_type as bindingType,
              pb.map_object_id as mapObjectId, pb.marker_id as markerId,
              pb.geometry_json as geometryJson, pb.created_at as createdAt,
              mo.raw_id as mapObjectRawId,
              mo.normalized_id as mapObjectNormalizedId,
              mo.bbox_json as mapObjectBBoxJson,
              m.marker_type_id as markerTypeId
       from poi_bindings pb
       left join map_objects mo on mo.id = pb.map_object_id
       left join markers m on m.id = pb.marker_id
       where pb.poi_id = ?
       order by pb.created_at desc`
    ).bind(id).all();
    return json(bindings.results);
  }
  if (resource === "pois" && request.method === "POST" && path.endsWith("/bindings")) {
    // POST /api/pois/:id/bindings
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const poi = await env.DB.prepare("select id from pois where id = ?").bind(id).first();
    if (!poi) return notFound();
    const body = await parseJsonBody<{
      bindingType: string;
      mapObjectId: string;
      markerId: string;
      geometryJson: unknown;
    }>(request);
    if (!body.bindingType) return json({ error: "bindingType is required" }, { status: 400 });
    if (body.bindingType === "svg-object" && !body.mapObjectId) {
      return json({ error: "mapObjectId is required for svg-object binding" }, { status: 400 });
    }
    if (body.bindingType === "marker" && !body.markerId) {
      return json({ error: "markerId is required for marker binding" }, { status: 400 });
    }
    const bindingId = makeId("bind");
    const now = nowIso();
    const statements = [
      env.DB.prepare(
        "update markers set poi_id = null, updated_at = ? where id in (select marker_id from poi_bindings where poi_id = ? and marker_id is not null)"
      ).bind(now, id),
      env.DB.prepare("delete from poi_bindings where poi_id = ?").bind(id),
      env.DB.prepare(
        "insert into poi_bindings (id, poi_id, binding_type, map_object_id, marker_id, geometry_json, created_at) values (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        bindingId, id, body.bindingType,
        body.mapObjectId || null, body.markerId || null,
        JSON.stringify(body.geometryJson ?? null), now
      ),
      env.DB.prepare("update pois set geometry = ?, status = case when status = 'issue' then 'draft' else status end, updated_at = ? where id = ?")
        .bind(body.bindingType === "marker" ? "marker" : body.bindingType === "svg-object" ? "svg-object" : "polygon", now, id),
    ];
    if (body.bindingType === "marker" && body.markerId) {
      statements.push(
        env.DB.prepare("update markers set poi_id = ?, updated_at = ? where id = ?").bind(id, now, body.markerId)
      );
    }
    await env.DB.batch(statements);
    await writeLog(env, "audit", `Replaced binding ${body.bindingType} for POI ${id}`, auth.email);
    return json({ ok: true, id: bindingId });
  }
  if (resource === "bindings" && id && request.method === "DELETE") {
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const binding = await env.DB.prepare("select poi_id as poiId, marker_id as markerId from poi_bindings where id = ?")
      .bind(id)
      .first<{ poiId: string; markerId: string | null }>();
    await env.DB.prepare("delete from poi_bindings where id = ?").bind(id).run();
    if (binding?.markerId) {
      await env.DB.prepare("update markers set poi_id = null, updated_at = ? where id = ?").bind(nowIso(), binding.markerId).run();
    }
    if (binding?.poiId) {
      const remaining = await env.DB.prepare("select binding_type as bindingType from poi_bindings where poi_id = ? order by created_at desc limit 1")
        .bind(binding.poiId)
        .first<{ bindingType: string }>();
      await env.DB.prepare("update pois set geometry = ?, status = case when ? = 'none' and status = 'draft' then 'issue' else status end, updated_at = ? where id = ?")
        .bind(remaining?.bindingType ?? "none", remaining?.bindingType ?? "none", nowIso(), binding.poiId)
        .run();
    }
    await writeLog(env, "audit", `Deleted binding ${id}`, auth.email);
    return json({ ok: true, id });
  }
  if (path === "/api/marker-types" && request.method === "GET") return json(await readMarkerTypes(env));
  if (path === "/api/marker-types" && request.method === "POST") return createMarkerType(request, env);
  if (resource === "marker-types" && id && request.method === "PATCH") return updateMarkerType(request, env, id);
  if (resource === "marker-types" && id && request.method === "DELETE") return deleteById(env, "marker_types", id);
  if (path === "/api/markers" && request.method === "GET") return json(await readAdminMarkers(env));
  if (path === "/api/markers" && request.method === "POST") return createMarker(request, env);
  if (resource === "markers" && id && request.method === "PATCH") return updateMarker(request, env, id);
  if (resource === "markers" && id && request.method === "DELETE") return deleteById(env, "markers", id);
  if (path === "/api/shuttle-routes" && request.method === "GET") return json(await readList(env, "shuttle_routes", "id asc"));
  if (path === "/api/shuttle-routes" && request.method === "POST") return upsertShuttleRoute(request, env);
  if (resource === "shuttle-routes" && id && request.method === "DELETE") return deleteById(env, "shuttle_routes", id);
  if (path === "/api/admins" && request.method === "GET") return json(await readList(env, "admins", "created_at desc"));
  if (path === "/api/admins" && request.method === "POST") return createAdmin(request, env);
  if (resource === "admins" && id && request.method === "DELETE") return deleteById(env, "admins", id);
  if (path === "/api/logs" && request.method === "GET") return json(await readList(env, "logs", "created_at desc"));
  if (path === "/api/backups" && request.method === "POST") {
    return createBackup(env);
  }
  if (path === "/api/backups" && request.method === "GET") {
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const backups = await env.DB.prepare(
      "select * from backups order by created_at desc limit 20"
    ).all();
    return json(backups.results);
  }
  if (resource === "backups" && id && request.method === "GET" && path.endsWith("/download")) {
    if (!env.SHUMAP_BUCKET) return json({ error: "R2 is not enabled" }, { status: 503 });
    const decodedKey = decodeURIComponent(id);
    const backupObject = await env.SHUMAP_BUCKET.get(decodedKey);
    if (!backupObject) return notFound();
    const filename = decodedKey.split("/").pop() || "shumap-backup.json";
    return new Response(await backupObject.arrayBuffer(), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  }
  if (resource === "backups" && id && request.method === "DELETE") {
    // DELETE /api/backups/:key — key is URL-encoded
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const decodedKey = decodeURIComponent(id);
    if (env.SHUMAP_BUCKET) {
      await env.SHUMAP_BUCKET.delete(decodedKey);
    }
    await env.DB.prepare("delete from backups where key = ?").bind(decodedKey).run();
    await writeLog(env, "audit", `Deleted backup ${decodedKey}`, auth.email);
    return json({ ok: true, key: decodedKey });
  }
  if (path === "/api/releases/publish" && request.method === "POST") {
    return publishRelease(env);
  }
  if (path === "/api/releases/current" && request.method === "GET") {
    return readCurrentReleaseSnapshot(env);
  }
  if (resource === "map-versions" && id) {
    if (request.method === "GET") {
      if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
      const version = await env.DB.prepare(
        "select id, campus, version, status, object_count as objectCount, unresolved_diffs as unresolvedDiffs, created_at as createdAt from map_versions where id = ?"
      ).bind(id).first();
      if (!version) return notFound();
      const diffs = await env.DB.prepare(
        "select id, map_version_id as mapVersionId, diff_type as diffType, normalized_id as normalizedId, detail_json as detailJson, status, created_at as createdAt, resolved_at as resolvedAt from svg_diffs where map_version_id = ? order by created_at desc limit 200"
      ).bind(id).all();
      const objects = await env.DB.prepare(
        "select id, normalized_id as normalizedId, raw_id as rawId, object_kind as objectKind, label_text as labelText from map_objects where map_version_id = ? order by created_at limit 500"
      ).bind(id).all();
      return json({ version, diffs: diffs.results, objects: objects.results });
    }
    if (request.method === "DELETE") {
      if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
      await env.DB.prepare("delete from map_versions where id = ?").bind(id).run();
      await writeLog(env, "audit", `Deleted map version ${id}`, auth.email);
      return json({ ok: true, id });
    }
  }
  // --- R2 Media routes ---
  if (path === "/api/media" && request.method === "GET") {
    if (!env.SHUMAP_BUCKET) return json({ error: "R2 is not enabled" }, { status: 503 });
    // Simplified list - R2 doesn't have a native list API in this polyfill, return stub
    return json({ files: [], note: "R2 list requires the R2 binding to be active" });
  }
  if (path === "/api/media/upload" && request.method === "POST") {
    return uploadMedia(request, env, auth.email, "uploads");
  }
  if (resource === "media" && id && request.method === "DELETE") {
    if (!env.SHUMAP_BUCKET) return json({ error: "R2 is not enabled" }, { status: 503 });
    const key = decodeURIComponent(id);
    await env.SHUMAP_BUCKET.delete(key);
    await writeLog(env, "audit", `Deleted media: ${key}`, auth.email);
    return json({ ok: true, key });
  }

  if (resource === "diffs" && id && request.method === "PATCH") {
    if (!env.DB) return json({ error: "D1 binding is missing" }, { status: 503 });
    const body = await parseJsonBody<{ status: string; poiId: string }>(request);
    const current = await env.DB.prepare("select id, map_version_id as mapVersionId, status from svg_diffs where id = ?")
      .bind(id)
      .first<{ id: string; mapVersionId: string; status: string }>();
    if (!current) return notFound();
    if (body.status === "resolved") {
      await env.DB.prepare(
        "update svg_diffs set status = 'resolved', resolved_at = ? where id = ?"
      ).bind(nowIso(), id).run();
    } else if (body.status === "ignored") {
      await env.DB.prepare(
        "update svg_diffs set status = 'ignored', resolved_at = ? where id = ?"
      ).bind(nowIso(), id).run();
    } else {
      return json({ error: "status must be 'resolved' or 'ignored'" }, { status: 400 });
    }

    if (current.status === "open") {
      await env.DB.prepare(
        "update map_versions set unresolved_diffs = max(0, unresolved_diffs - 1), updated_at = ? where id = ?"
      ).bind(nowIso(), current.mapVersionId).run();
      const openLeft = await env.DB.prepare("select count(*) as count from svg_diffs where map_version_id = ? and status = 'open'")
        .bind(current.mapVersionId)
        .first<{ count: number }>();
      if ((openLeft?.count ?? 0) === 0) {
        await env.DB.prepare("update validation_issues set resolved_at = ? where target = ? and resolved_at is null")
          .bind(nowIso(), `map:${current.mapVersionId}`)
          .run();
      }
    }
    await writeLog(env, "audit", `Updated diff ${id} to ${body.status}`, auth.email);
    return json({ ok: true, id, status: body.status });
  }
  return notFound();
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env);
      } catch (error) {
        await writeLog(env, "error", error instanceof Error ? error.message : "Unknown API error", "worker");
        return json({ error: error instanceof Error ? error.message : "Unknown API error" }, { status: 500 });
      }
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("SHUMap worker is running. Static assets binding is missing.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
  async queue(batch: { messages: Array<{ body: unknown; ack(): void; retry(): void }> }, env: Env) {
    for (const message of batch.messages) {
      try {
        await writeLog(env, "debug", "Processed queued admin job", "queue", message.body);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};
