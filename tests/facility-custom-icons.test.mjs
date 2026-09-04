// 后台可上传的设施图标（0029）+ 「图标以管理员选的 icon_key 为准」这条缺口的回归。
//
// 为什么用真 sqlite 而不是假 DB：这条通道的关键语义有一半在 SQL 里 —— icon_key 的
// unique 约束、facility_types 的引用检查、media_assets 的 status 流转。假 DB 只能
// 断言「发出了这条语句」，断言不了「这条语句真的拦住了重复键」。
//
// 覆盖的东西分三组：
//   ① 上传校验：安全（脚本 / on* / 外部引用）+ 颜色可替换 + viewBox + 体积 + 键形状
//   ② 生命周期：同键替换、在用不可删、停用的键不能再被选
//   ③ 读取：?ink= 上色、ETag 按 ink 分离、304
//   ④ 缺口回归：resolveFacilityIconKey 优先认管理员选的键，而不是拿编码去猜

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 被测模块
// ---------------------------------------------------------------------------

const workerBundle = await build({
  stdin: {
    contents: `
      export {
        uploadFacilityIcon,
        updateFacilityIcon,
        deleteFacilityIcon,
        listFacilityIcons,
        getPublicFacilityIcon,
        inkedSvg,
        isCustomIconKey,
      } from "./worker/modules/facility-icons.ts";
      export { createFacilityType, listFacilityTypes } from "./worker/modules/facility-types.ts";
    `,
    resolveDir: root,
    sourcefile: "facility-icons-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const icons = await import(
  `data:text/javascript;base64,${Buffer.from(workerBundle.outputFiles[0].contents).toString("base64")}`
);

/* facilityIcons.tsx 是 Web 端的图标层（缺口修复就在这里）。
   react / lucide-react 都打进 bundle 而不是标 external：产物是从 data: URL import 的，
   而 data: URL 没有「所在目录」，裸包名（react/jsx-runtime）在那里解析不了。
   被测的四个函数都是纯函数，打进来只是为了让模块顶层的组件引用能求值。 */
const webBundle = await build({
  stdin: {
    contents: `
      export {
        resolveFacilityIconKey,
        facilityIconKeyMap,
        isCustomIconKey,
        facilityIconUrl,
        FACILITY_TYPE_CODE_ICON_KEYS,
      } from "./src/lib/facilityIcons.tsx";
    `,
    resolveDir: root,
    sourcefile: "facility-icons-web-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  jsx: "automatic",
  write: false,
});
const web = await import(
  `data:text/javascript;base64,${Buffer.from(webBundle.outputFiles[0].contents).toString("base64")}`
);

// ---------------------------------------------------------------------------
// D1 外观 + R2 桩
// ---------------------------------------------------------------------------

class Statement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.db, this.sql, values);
  }

  async first() {
    // D1 的 first() 没有行时回 null，node:sqlite 回 undefined。
    return this.db.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.db.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    // D1 的 batch 是一个隐式事务：一条失败则整批不生效。
    this.db.exec("begin");
    try {
      for (const statement of statements) await statement.run();
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

class Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, bytes, options) {
    this.objects.set(key, { bytes: Buffer.from(bytes), options });
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      size: stored.bytes.byteLength,
      body: stored.bytes,
      async text() {
        return stored.bytes.toString("utf8");
      },
    };
  }
}

function environment() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("pragma foreign_keys = on;");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(fs.readFileSync(path.join(root, "migrations-v2", name), "utf8"));
  }
  raw.exec(`
    insert into users(id,email,display_name,password_hash,status,created_at,updated_at)
      values('user_admin','a@shu.edu.cn','管理员','x','active',datetime('now'),datetime('now'));
  `);
  return { raw, env: { DB: new Database(raw), SHUMAP_BUCKET: new Bucket() } };
}

const principal = { userId: "user_admin", roles: ["admin"], permissions: ["write:content"] };

/** 合格的图标：单色描边、只写 currentColor、带 viewBox。 */
const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor"/></svg>';

function put(key, body, label) {
  const query = label === undefined ? "" : `?label=${encodeURIComponent(label)}`;
  return new Request(`https://map.shutf.com/api/admin/facility-icons/${key}${query}`, {
    method: "PUT",
    body,
  });
}

async function upload(env, key, body = GOOD_SVG, label = "直饮水机") {
  return icons.uploadFacilityIcon(put(key, body, label), env, principal, key, "req_1");
}

/** 上传应当被拒：回 [status, code]。 */
async function rejection(env, key, body, label) {
  try {
    await icons.uploadFacilityIcon(put(key, body, label), env, principal, key, "req_1");
  } catch (error) {
    return [error.status, error.code, error.message];
  }
  throw new Error("上传本应被拒绝，但通过了");
}

// ---------------------------------------------------------------------------
// ① 上传校验
// ---------------------------------------------------------------------------

test("合格的 SVG 上传后落库、落 R2，并回 201", async () => {
  const { raw, env } = environment();
  const response = await upload(env, "custom-water-dispenser");
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.iconKey, "custom-water-dispenser");
  assert.equal(body.label, "直饮水机");
  assert.equal(body.metadata.viewBox, "0 0 24 24");

  const row = raw.prepare("select icon_key,label,status,metadata_json from facility_icons").get();
  assert.equal(row.icon_key, "custom-water-dispenser");
  assert.equal(row.status, "active");
  assert.equal(JSON.parse(row.metadata_json).viewBox, "0 0 24 24");

  /* 字节进的是 public/facility-icons/ 前缀 —— 公共读端只认这个前缀。
     只查图标那几行：迁移种子里已经有三条校区底图的 media_assets（0011），
     不加条件的 select 会先撞上它们。 */
  const media = raw.prepare(
    `select m.object_key,m.content_type,m.status,m.bucket_scope
       from facility_icons i join media_assets m on m.id=i.media_asset_id`,
  ).get();
  assert.ok(media.object_key.startsWith("public/facility-icons/"));
  assert.equal(media.content_type, "image/svg+xml");
  assert.equal(media.status, "published");
  assert.equal(media.bucket_scope, "public");
  assert.equal(env.SHUMAP_BUCKET.objects.size, 1);
  raw.close();
});

test("带 <script> 的 SVG 被拒（共用 svg-safety 那份判定）", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24" stroke="currentColor"><script>alert(1)</script></svg>';
  const [status, code] = await rejection(env, "custom-evil", svg);
  assert.equal(status, 400);
  assert.equal(code, "unsafe_svg");
  assert.equal(raw.prepare("select count(*) as n from facility_icons").get().n, 0);
  raw.close();
});

test("带 on* 事件属性的 SVG 被拒", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24" stroke="currentColor"><path onload="x()" d="M0 0"/></svg>';
  const [status, code] = await rejection(env, "custom-onload", svg);
  assert.equal(status, 400);
  assert.equal(code, "unsafe_svg");
  raw.close();
});

test("引用外部文档的 SVG 被拒（会泄露访问者 IP）", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24" stroke="currentColor"><image href="https://evil.example/x.png"/></svg>';
  const [status, code] = await rejection(env, "custom-external", svg);
  assert.equal(status, 400);
  assert.equal(code, "unsafe_svg");
  raw.close();
});

test("写死颜色的 SVG 被拒，且错误里点出是哪个值", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24"><path stroke="#ff0000" d="M0 0"/></svg>';
  const [status, code, message] = await rejection(env, "custom-red", svg);
  assert.equal(status, 400);
  assert.equal(code, "icon_color_not_replaceable");
  // 拒收要能让上传者知道去改哪里，所以必须回具体色值而不是一句「格式不对」。
  assert.match(message, /#ff0000/);
  raw.close();
});

test("style 内联声明里写死颜色同样被拒（属性检查绕不过去）", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24"><path style="stroke:#123456" d="M0 0"/></svg>';
  const [status, code] = await rejection(env, "custom-inline", svg);
  assert.equal(status, 400);
  assert.equal(code, "icon_color_not_replaceable");
  raw.close();
});

test("<style> 样式块被拒：颜色藏在 CSS 里就替换不到", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24" stroke="currentColor"><style>path{stroke:#000}</style></svg>';
  const [status, code] = await rejection(env, "custom-styleblock", svg);
  assert.equal(status, 400);
  assert.equal(code, "icon_color_not_replaceable");
  raw.close();
});

test("渐变填充被拒：图钉只有单色两态", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24" stroke="currentColor">'
    + '<defs><linearGradient id="g"/></defs></svg>';
  const [status, code] = await rejection(env, "custom-gradient", svg);
  assert.equal(status, 400);
  assert.equal(code, "icon_color_not_replaceable");
  raw.close();
});

test("一处 currentColor 都没有的 SVG 被拒（默认黑填充画在蓝底上看不见）", async () => {
  const { raw, env } = environment();
  const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
  const [status, code] = await rejection(env, "custom-nocolor", svg);
  assert.equal(status, 400);
  assert.equal(code, "icon_color_not_replaceable");
  raw.close();
});

test("缺 viewBox 的 SVG 被拒：两端都靠它等比缩放", async () => {
  const { raw, env } = environment();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" stroke="currentColor"></svg>';
  const [status, code] = await rejection(env, "custom-noviewbox", svg);
  assert.equal(status, 400);
  assert.equal(code, "validation_error");
  raw.close();
});

test("超过 64KB 的文件被拒", async () => {
  const { raw, env } = environment();
  const filler = " ".repeat(70 * 1024);
  const svg = `<svg viewBox="0 0 24 24" stroke="currentColor">${filler}</svg>`;
  const [status, code] = await rejection(env, "custom-huge", svg);
  assert.equal(status, 413);
  assert.equal(code, "payload_too_large");
  raw.close();
});

test("空 body 被拒", async () => {
  const { raw, env } = environment();
  const [status] = await rejection(env, "custom-empty", "");
  assert.equal(status, 400);
  raw.close();
});

test("键必须带 custom- 前缀：没有前缀直接拒（客户端靠它分流）", async () => {
  const { raw, env } = environment();
  const [status, code] = await rejection(env, "water-dispenser", GOOD_SVG);
  assert.equal(status, 400);
  assert.equal(code, "invalid_icon_key");
  raw.close();
});

test("键里的大写、下划线、连续连字符都拒", async () => {
  const { raw, env } = environment();
  for (const key of ["custom-Water", "custom-water_dispenser", "custom--water", "custom-water-", "custom-"]) {
    const [status, code] = await rejection(env, key, GOOD_SVG);
    assert.equal(status, 400, `${key} 应被拒`);
    assert.equal(code, "invalid_icon_key", `${key} 应被拒`);
  }
  raw.close();
});

test("键长超过 50 被拒：要存进 facility_types.icon_key，那列的写入校验是 50", async () => {
  const { raw, env } = environment();
  const key = `custom-${"a".repeat(45)}`;
  assert.ok(key.length > 50);
  const [status, code] = await rejection(env, key, GOOD_SVG);
  assert.equal(status, 400);
  assert.equal(code, "invalid_icon_key");
  raw.close();
});

test("新建图标必须给名称（图标网格要显示它）", async () => {
  const { raw, env } = environment();
  const request = put("custom-nameless", GOOD_SVG, undefined);
  await assert.rejects(
    () => icons.uploadFacilityIcon(request, env, principal, "custom-nameless", "req_1"),
    (error) => error.status === 400 && error.code === "validation_error",
  );
  raw.close();
});

// ---------------------------------------------------------------------------
// ② 生命周期
// ---------------------------------------------------------------------------

test("同键重传即替换：只有一行，旧 media 标 deleted 而非物删（审计要能溯源）", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  const firstMedia = raw.prepare("select media_asset_id from facility_icons").get().media_asset_id;

  const replaced = '<svg viewBox="0 0 32 32" stroke="currentColor"><circle r="8" fill="none"/></svg>';
  const response = await icons.uploadFacilityIcon(
    put("custom-water", replaced, undefined), env, principal, "custom-water", "req_2",
  );
  assert.equal(response.status, 200, "替换回 200 而不是 201");
  const body = await response.json();
  assert.equal(body.label, "饮水", "不给 label 时沿用原名");
  assert.equal(body.metadata.viewBox, "0 0 32 32");

  assert.equal(raw.prepare("select count(*) as n from facility_icons").get().n, 1);
  // 只看图标的 media 行（种子里另有三条校区底图，见 0011）。
  const statuses = raw.prepare(
    "select id,status from media_assets where object_key like 'public/facility-icons/%' order by created_at,id",
  ).all();
  assert.equal(statuses.length, 2, "旧 media 行留档");
  assert.equal(statuses.find((row) => row.id === firstMedia).status, "deleted");
  raw.close();
});

test("PATCH 能改名与停用，停用后不再是可选项", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");

  const request = new Request("https://map.shutf.com/api/admin/facility-icons/custom-water", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "直饮水", status: "disabled" }),
  });
  const body = await (await icons.updateFacilityIcon(request, env, principal, "custom-water", "req_3")).json();
  assert.equal(body.label, "直饮水");
  assert.equal(body.status, "disabled");

  assert.equal(raw.prepare("select status from facility_icons where icon_key='custom-water'").get().status, "disabled");
  // 「停用后不能再被选」由下面那条 createFacilityType 的断言把关（normalizeIconKey 直接查库）。
  raw.close();
});

test("还有设施类型在用时删不掉，错误里点名是哪个类型", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  // 插 disabled 的类型：0012 的触发器只在 status='active' 时要求已归属启用按钮。
  raw.exec(`
    insert into facility_types(id,code,name,category,icon_key,visibility_policy_json,status,created_at,updated_at)
      values('ft_wd','water_dispenser','直饮水机','amenity','custom-water','{}','disabled',
             datetime('now'),datetime('now'));
  `);

  await assert.rejects(
    () => icons.deleteFacilityIcon(env, principal, "custom-water", "req_4"),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "facility_icon_in_use");
      assert.match(error.message, /直饮水机/);
      return true;
    },
  );
  assert.equal(raw.prepare("select count(*) as n from facility_icons").get().n, 1);
  raw.close();
});

test("没人引用时可以删，media 行标 deleted", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  const body = await (await icons.deleteFacilityIcon(env, principal, "custom-water", "req_5")).json();
  assert.equal(body.deleted, true);
  assert.equal(raw.prepare("select count(*) as n from facility_icons").get().n, 0);
  assert.equal(
    raw.prepare(
      "select status from media_assets where object_key like 'public/facility-icons/%'",
    ).get().status,
    "deleted",
    "行留档而非物删（审计要能回答「这枚图标什么时候被谁删的」）",
  );
  raw.close();
});

test("列表回引用数：>0 的那枚界面上不给删", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  await upload(env, "custom-idle", GOOD_SVG, "没人用");
  raw.exec(`
    insert into facility_types(id,code,name,category,icon_key,visibility_policy_json,status,created_at,updated_at)
      values('ft_wd','water_dispenser','直饮水机','amenity','custom-water','{}','disabled',
             datetime('now'),datetime('now'));
  `);
  const body = await (await icons.listFacilityIcons(env)).json();
  const byKey = new Map(body.items.map((item) => [item.iconKey, item]));
  assert.equal(byKey.get("custom-water").usageCount, 1);
  assert.equal(byKey.get("custom-idle").usageCount, 0);
  raw.close();
});

// ---------------------------------------------------------------------------
// ③ 读取：上色与缓存
// ---------------------------------------------------------------------------

test("inkedSvg 把 currentColor 换成实际色值（两端拿到的都是已上色的死图）", () => {
  const source = '<svg viewBox="0 0 24 24" stroke="currentColor"><path fill="currentColor"/></svg>';
  const primary = icons.inkedSvg(source, "primary");
  assert.match(primary, /stroke="#1e80c1"/);
  assert.match(primary, /fill="#1e80c1"/);
  assert.equal(/currentColor/i.test(primary), false, "不留 currentColor：<image> 引用时继承不到外面的 color");

  const white = icons.inkedSvg(source, "white");
  assert.match(white, /stroke="#ffffff"/);
  // 根节点补一个 color，兜住理论上可能残留的 currentColor。
  assert.match(white, /<svg style="color:#ffffff"/);
});

test("公共读端按 ink 上色，且 ETag 随 ink 变化（否则白图标会吃到蓝图标的缓存）", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");

  const blue = await icons.getPublicFacilityIcon(
    new Request("https://map.shutf.com/api/public/facility-icons/custom-water?ink=primary"),
    env, "custom-water",
  );
  const white = await icons.getPublicFacilityIcon(
    new Request("https://map.shutf.com/api/public/facility-icons/custom-water?ink=white"),
    env, "custom-water",
  );
  assert.equal(blue.headers.get("content-type"), "image/svg+xml");
  assert.match(await blue.text(), /#1e80c1/);
  assert.match(await white.text(), /#ffffff/);

  const blueTag = blue.headers.get("etag");
  const whiteTag = white.headers.get("etag");
  assert.notEqual(blueTag, whiteTag, "同一份字节的两种颜色必须是两个 ETag");

  // 按键寻址且键下的图会被替换，所以不能 immutable —— 那会让浏览器一年不回源。
  assert.match(blue.headers.get("cache-control"), /must-revalidate/);
  assert.equal(/immutable/.test(blue.headers.get("cache-control")), false);
  assert.equal(blue.headers.get("x-content-type-options"), "nosniff");
  assert.match(blue.headers.get("content-security-policy"), /default-src 'none'/);
  raw.close();
});

test("ink 缺省是 primary", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  const response = await icons.getPublicFacilityIcon(
    new Request("https://map.shutf.com/api/public/facility-icons/custom-water"),
    env, "custom-water",
  );
  assert.match(await response.text(), /#1e80c1/);
  raw.close();
});

test("If-None-Match 命中回 304（含 W/ 前缀与多值）", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  const first = await icons.getPublicFacilityIcon(
    new Request("https://map.shutf.com/api/public/facility-icons/custom-water?ink=primary"),
    env, "custom-water",
  );
  const etag = first.headers.get("etag");

  for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
    const response = await icons.getPublicFacilityIcon(
      new Request("https://map.shutf.com/api/public/facility-icons/custom-water?ink=primary", {
        headers: { "if-none-match": header },
      }),
      env, "custom-water",
    );
    assert.equal(response.status, 304, `if-none-match: ${header}`);
  }
  raw.close();
});

test("换图后同一个键的 ETag 变了（引用它的类型自动跟着换图）", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  const before = (await icons.getPublicFacilityIcon(
    new Request("https://map.shutf.com/api/public/facility-icons/custom-water"), env, "custom-water",
  )).headers.get("etag");

  await icons.uploadFacilityIcon(
    put("custom-water", '<svg viewBox="0 0 24 24" stroke="currentColor"><circle r="4"/></svg>', undefined),
    env, principal, "custom-water", "req_6",
  );
  const after = (await icons.getPublicFacilityIcon(
    new Request("https://map.shutf.com/api/public/facility-icons/custom-water"), env, "custom-water",
  )).headers.get("etag");
  assert.notEqual(before, after);
  raw.close();
});

test("未知 ink 回 400，未知键回 404，键形状不合法也回 404（不泄露存在性）", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");

  await assert.rejects(
    () => icons.getPublicFacilityIcon(
      new Request("https://map.shutf.com/api/public/facility-icons/custom-water?ink=rainbow"),
      env, "custom-water",
    ),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => icons.getPublicFacilityIcon(
      new Request("https://map.shutf.com/api/public/facility-icons/custom-missing"), env, "custom-missing",
    ),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () => icons.getPublicFacilityIcon(
      new Request("https://map.shutf.com/api/public/facility-icons/../../etc/passwd"), env, "../../etc/passwd",
    ),
    (error) => error.status === 404,
  );
  raw.close();
});

// ---------------------------------------------------------------------------
// ④ 与 facility_types 的接口
// ---------------------------------------------------------------------------

test("新建设施类型可以选一枚启用中的自定义图标", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  const request = new Request("https://map.shutf.com/api/admin/facility-types", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "water_dispenser", name: "直饮水机", iconKey: "custom-water" }),
  });
  const body = await (await icons.createFacilityType(request, env, principal, "req_7")).json();
  assert.equal(body.iconKey, "custom-water");
  assert.equal(raw.prepare("select icon_key from facility_types where code='water_dispenser'").get().icon_key,
    "custom-water");
  raw.close();
});

test("停用或不存在的自定义键会被拒，而不是静默存下一个取不到图的键", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  await icons.updateFacilityIcon(
    new Request("https://map.shutf.com/api/admin/facility-icons/custom-water", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    }),
    env, principal, "custom-water", "req_8",
  );

  for (const iconKey of ["custom-water", "custom-nonexistent"]) {
    const request = new Request("https://map.shutf.com/api/admin/facility-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: `t_${iconKey.replace(/-/g, "_")}`, name: "测试", iconKey }),
    });
    await assert.rejects(
      () => icons.createFacilityType(request, env, principal, "req_9"),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, "unsupported_icon_key");
        return true;
      },
      `${iconKey} 应被拒`,
    );
  }
  raw.close();
});

test("内置键仍然照常可用（自定义分支不能挡住原有的 23 枚）", async () => {
  const { raw, env } = environment();
  const request = new Request("https://map.shutf.com/api/admin/facility-types", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "book_locker", name: "借书柜", iconKey: "locker" }),
  });
  const body = await (await icons.createFacilityType(request, env, principal, "req_10")).json();
  assert.equal(body.iconKey, "locker");
  raw.close();
});

test("既不是内置也不带 custom- 前缀的键被拒", async () => {
  const { raw, env } = environment();
  const request = new Request("https://map.shutf.com/api/admin/facility-types", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "weird", name: "怪东西", iconKey: "not_a_real_icon" }),
  });
  await assert.rejects(
    () => icons.createFacilityType(request, env, principal, "req_11"),
    (error) => error.status === 400 && error.code === "unsupported_icon_key",
  );
  raw.close();
});

test("GET /facility-types 把自定义图标连中文名一起回给界面", async () => {
  const { raw, env } = environment();
  await upload(env, "custom-water", GOOD_SVG, "饮水");
  const body = await (await icons.listFacilityTypes(env)).json();
  assert.deepEqual(body.customIcons, [{ iconKey: "custom-water", label: "饮水", status: "active" }]);
  // 内置清单不受影响。
  assert.ok(body.iconKeys.includes("generic"));
  raw.close();
});

test("两端对 custom- 前缀的判定一致（客户端据此分流）", () => {
  for (const key of ["custom-water", "custom-a-b-c"]) {
    assert.equal(icons.isCustomIconKey(key), true, key);
    assert.equal(web.isCustomIconKey(key), true, key);
  }
  for (const key of ["water", "generic", "", null, undefined]) {
    assert.equal(icons.isCustomIconKey(key), false, String(key));
    assert.equal(web.isCustomIconKey(key), false, String(key));
  }
});

// ---------------------------------------------------------------------------
// ⑤ 缺口回归：图标以管理员选的 icon_key 为准
//
// 此前 POI 详情 / 楼层图 / 平面图钉 / 采集表单四处用 facilityIcon(typeCode)，那是拿
// 「类型编码」去撞图标键。出厂九类靠手写映射能对上，后台新建的类型一律掉到通用图钉 ——
// 管理员选了什么都不生效。下面这几条钉住修复后的优先级。
// ---------------------------------------------------------------------------

test("管理员选的 iconKey 优先于按编码猜", () => {
  const map = web.facilityIconKeyMap([{ code: "water_dispenser", iconKey: "water" }]);
  assert.equal(web.resolveFacilityIconKey("water_dispenser", map), "water");
});

test("自定义图标也能通过这条路解析出来（四处视图因此能画出上传的图标）", () => {
  const map = web.facilityIconKeyMap([{ code: "water_dispenser", iconKey: "custom-water" }]);
  assert.equal(web.resolveFacilityIconKey("water_dispenser", map), "custom-water");
});

test("这就是修复前的表现：没有查表时，后台新建的类型掉到通用图钉", () => {
  // 回归的锚点。传 null 等于「手上没有发布数据」，只能按编码猜 —— 猜不中。
  assert.equal(web.resolveFacilityIconKey("water_dispenser", null), null);
});

test("出厂九类的编码与图标键刻意不同名，所以必须有手写映射兜住", () => {
  for (const [code, expected] of Object.entries(web.FACILITY_TYPE_CODE_ICON_KEYS)) {
    assert.equal(web.resolveFacilityIconKey(code, null), expected, code);
  }
  // 抽三个确认「编码 ≠ 图标键」这件事本身成立 —— 否则这张表就是多余的。
  assert.equal(web.FACILITY_TYPE_CODE_ICON_KEYS.drinking_water, "water");
  assert.equal(web.FACILITY_TYPE_CODE_ICON_KEYS.vending_machine, "vending");
  assert.equal(web.FACILITY_TYPE_CODE_ICON_KEYS.service_center, "service");
});

test("类型在发布数据里但没设图标时，退回按编码猜而不是空", () => {
  const map = web.facilityIconKeyMap([{ code: "drinking_water", iconKey: null }]);
  assert.equal(web.resolveFacilityIconKey("drinking_water", map), "water");
});

test("编码恰好与内置图标键同名时也能对上（第二级回落）", () => {
  assert.equal(web.resolveFacilityIconKey("printer", null), "printer");
  assert.equal(web.resolveFacilityIconKey("bus", null), "bus");
});

test("完全不认识的编码回 null，由渲染层落通用标记", () => {
  assert.equal(web.resolveFacilityIconKey("nonsense_type", new Map()), null);
});

test("图标地址带 ink，且与服务端的两档一致", () => {
  assert.equal(web.facilityIconUrl("custom-water"), "/api/public/facility-icons/custom-water?ink=primary");
  assert.equal(web.facilityIconUrl("custom-water", "white"), "/api/public/facility-icons/custom-water?ink=white");
});
