// 返校指南模块：内容版本流转、发布守卫、SVG 消毒。
//
// 为什么这三件事值得钉在测试里：
//   1. 回滚。指南最要紧的能力是「票价录错了能立刻退回上一版」。开发中曾照抄
//      place/facility 的「至多一版 approved」写法，把旧版标成 superseded，
//      而发布守卫只认 approved —— 结果旧版再也发不回去，回滚静默失效。
//   2. 发布守卫。草稿绝不能上线。这条由 D1 触发器兜底，即使绕过 worker
//      直接改库也拦得住，所以要直接对着触发器测。
//   3. SVG 消毒。图示会被内联进 DOM 才能高亮线路，等于把上传的标记
//      当代码执行。同时原稿图示合法地内嵌位图底图（<image href="data:image/png">），
//      所以规则必须「拦脚本、放位图」——开发中第一版规则一律拒 data:，
//      把真实原稿全部拒之门外。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const bundle = await build({
  stdin: {
    contents: `
      export {
        createGuideDocument,
        saveGuideRevision,
        submitGuideRevision,
        reviewGuideRevision,
        publishGuideRevision,
        unpublishGuideDocument,
        getPublicGuide,
        getPublicGuideAsset,
        uploadGuideAsset,
        deleteGuideAsset,
        listGuideAssets,
      } from "./worker/modules/guide.ts";
    `,
    resolveDir: root,
    sourcefile: "guide-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const guide = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

class Statement {
  constructor(sqlite, sql, values = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.sqlite, this.sql, values);
  }

  async first() {
    return this.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.sqlite.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class D1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("begin");
    try {
      for (const statement of statements) this.sqlite.prepare(statement.sql).run(...statement.values);
      this.sqlite.exec("commit");
    } catch (error) {
      this.sqlite.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

/** R2 替身：只记住写进去的对象，够验证「上传成功后能读回」。 */
class Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, bytes, options) {
    this.objects.set(key, { bytes, options });
    return { key };
  }

  async get(key) {
    const hit = this.objects.get(key);
    if (!hit) return null;
    return { body: hit.bytes, size: hit.bytes.byteLength ?? hit.bytes.length };
  }
}

const now = "2026-08-05T00:00:00.000Z";
const principal = { userId: "user_editor", permissions: ["write:content"] };

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(read(`migrations-v2/${name}`));
  }
  sqlite.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_editor','editor@example.test','编辑','hash','active',1,?,?)`,
  ).run(now, now);
  return sqlite;
}

function env(sqlite) {
  return { DB: new D1(sqlite), SHUMAP_BUCKET: new Bucket() };
}

/** 最小可渲染内容（schema v2）：渲染层要求至少有 cards 与 hubs。 */
function content(overrides = {}) {
  return {
    schema: 2,
    meta: { title: "上海大学", subtitle: "新生入校交通指南", edition: "2025 版" },
    campuses: [{ id: "baoshan", label: "宝山校区", short: "宝山" }],
    hubs: [{ id: "hongqiao", name: "虹桥枢纽", color: "#3aa17e", order: 1 }],
    cards: [
      {
        id: "hq-bs-metro",
        kind: "route",
        hub: "hongqiao",
        campus: "baoshan",
        origin: { name: "虹桥枢纽" },
        mode: "metro",
        modeLabel: "地铁",
        durationMin: 75,
        fareYuan: 6,
        legs: [{ type: "stop", name: "虹桥火车站", marker: "dot" }],
      },
    ],
    ...overrides,
  };
}

function jsonRequest(body, url = "https://example.test/api/admin/guide/documents") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function payload(response) {
  return JSON.parse(await response.text());
}

/** 建文档 → 存内容 → 送审 → 批准，返回 {documentId, revisionId}。 */
async function approvedRevision(e, overrides = {}) {
  const created = await payload(await guide.createGuideDocument(
    jsonRequest({ slug: "freshman-transit", title: "新生入校交通指南" }),
    e, principal, "req_1",
  ));
  const saved = await payload(await guide.saveGuideRevision(
    jsonRequest({ title: "新生入校交通指南", edition: "2025 版", content: content(overrides) }),
    e, principal, created.id, "req_2",
  ));
  await guide.submitGuideRevision(jsonRequest({}), e, principal, saved.id, "req_3");
  await guide.reviewGuideRevision(
    jsonRequest({ decision: "approve" }), e, principal, saved.id, "req_4",
  );
  return { documentId: created.id, revisionId: saved.id };
}

// ---------------------------------------------------------------------------
// 发布守卫：草稿不可上线
// ---------------------------------------------------------------------------

test("the publish trigger refuses a revision that is not approved", () => {
  const sqlite = database();
  sqlite.prepare(
    `insert into guide_documents(id,slug,title,lifecycle_status,created_by,created_at,updated_at)
     values('guide_1','freshman-transit','指南','draft','user_editor',?,?)`,
  ).run(now, now);
  sqlite.prepare(
    `insert into guide_revisions(id,document_id,revision_no,editorial_status,title,content_json,content_hash,created_by,created_at)
     values('grev_draft','guide_1',1,'draft','指南','{}','hash_a','user_editor',?)`,
  ).run(now);

  assert.throws(
    () => sqlite.prepare("update guide_documents set current_revision_id='grev_draft' where id='guide_1'").run(),
    /must reference an approved revision/,
  );
});

test("the publish trigger refuses a revision belonging to another document", () => {
  const sqlite = database();
  for (const [id, slug] of [["guide_1", "a"], ["guide_2", "b"]]) {
    sqlite.prepare(
      `insert into guide_documents(id,slug,title,lifecycle_status,created_by,created_at,updated_at)
       values(?,?,'指南','draft','user_editor',?,?)`,
    ).run(id, slug, now, now);
  }
  sqlite.prepare(
    `insert into guide_revisions(id,document_id,revision_no,editorial_status,title,content_json,content_hash,created_by,created_at)
     values('grev_other','guide_2',1,'approved','指南','{}','hash_b','user_editor',?)`,
  ).run(now);

  assert.throws(
    () => sqlite.prepare("update guide_documents set current_revision_id='grev_other' where id='guide_1'").run(),
    /must reference an approved revision/,
  );
});

test("an approved revision of the same document may be published", () => {
  const sqlite = database();
  sqlite.prepare(
    `insert into guide_documents(id,slug,title,lifecycle_status,created_by,created_at,updated_at)
     values('guide_1','freshman-transit','指南','draft','user_editor',?,?)`,
  ).run(now, now);
  sqlite.prepare(
    `insert into guide_revisions(id,document_id,revision_no,editorial_status,title,content_json,content_hash,created_by,created_at)
     values('grev_ok','guide_1',1,'approved','指南','{}','hash_c','user_editor',?)`,
  ).run(now);

  sqlite.prepare("update guide_documents set current_revision_id='grev_ok' where id='guide_1'").run();
  const row = sqlite.prepare("select current_revision_id as id from guide_documents where id='guide_1'").get();
  assert.equal(row.id, "grev_ok");
});

// ---------------------------------------------------------------------------
// 版本流转
// ---------------------------------------------------------------------------

test("saving twice reuses the open draft instead of stacking revisions", async () => {
  const e = env(database());
  const created = await payload(await guide.createGuideDocument(
    jsonRequest({ slug: "freshman-transit", title: "指南" }), e, principal, "req_1",
  ));
  const first = await payload(await guide.saveGuideRevision(
    jsonRequest({ title: "指南", content: content() }), e, principal, created.id, "req_2",
  ));
  const second = await payload(await guide.saveGuideRevision(
    jsonRequest({ title: "指南", content: content() }), e, principal, created.id, "req_3",
  ));

  assert.equal(second.id, first.id);
  assert.equal(second.revisionNo, 1);
  // 同内容重复保存不写库
  assert.equal(second.unchanged, true);
});

test("a revision under review cannot be edited", async () => {
  const e = env(database());
  const created = await payload(await guide.createGuideDocument(
    jsonRequest({ slug: "freshman-transit", title: "指南" }), e, principal, "req_1",
  ));
  const saved = await payload(await guide.saveGuideRevision(
    jsonRequest({ title: "指南", content: content() }), e, principal, created.id, "req_2",
  ));
  await guide.submitGuideRevision(jsonRequest({}), e, principal, saved.id, "req_3");

  await assert.rejects(
    guide.saveGuideRevision(
      jsonRequest({ title: "指南", content: content({ cards: [] }) }), e, principal, created.id, "req_4",
    ),
    /under review/,
  );
});

test("editing after approval opens the next revision rather than mutating the live one", async () => {
  const e = env(database());
  const { documentId, revisionId } = await approvedRevision(e);
  await guide.publishGuideRevision(jsonRequest({ revisionId }), e, principal, documentId, "req_5");

  const next = await payload(await guide.saveGuideRevision(
    jsonRequest({ title: "指南", content: content({ cards: [] }) }), e, principal, documentId, "req_6",
  ));
  assert.equal(next.revisionNo, 2);
  assert.notEqual(next.id, revisionId);

  // 线上仍是第 1 版：新草稿不影响已发布内容
  const live = await payload(await guide.getPublicGuide(
    new Request("https://example.test/api/public/guide/freshman-transit"), e, "freshman-transit",
  ));
  assert.equal(live.revisionNo, 1);
  assert.equal(live.content.cards.length, 1);
});

// ---------------------------------------------------------------------------
// 回滚：这个模块最要紧的能力
// ---------------------------------------------------------------------------

test("approving a newer revision keeps older approved revisions publishable", async () => {
  const e = env(database());
  const { documentId, revisionId: first } = await approvedRevision(e);
  await guide.publishGuideRevision(jsonRequest({ revisionId: first }), e, principal, documentId, "req_5");

  // 第 2 版：把票价从 6 改成 7
  const second = await payload(await guide.saveGuideRevision(
    jsonRequest({
      title: "指南",
      content: content({ cards: [{ ...content().cards[0], fareYuan: 7 }] }),
    }),
    e, principal, documentId, "req_6",
  ));
  await guide.submitGuideRevision(jsonRequest({}), e, principal, second.id, "req_7");
  await guide.reviewGuideRevision(jsonRequest({ decision: "approve" }), e, principal, second.id, "req_8");
  await guide.publishGuideRevision(jsonRequest({ revisionId: second.id }), e, principal, documentId, "req_9");

  let live = await payload(await guide.getPublicGuide(
    new Request("https://example.test/api/public/guide/freshman-transit"), e, "freshman-transit",
  ));
  assert.equal(live.content.cards[0].fareYuan, 7);

  // 回滚：批准第 2 版不该把第 1 版锁死
  await guide.publishGuideRevision(jsonRequest({ revisionId: first }), e, principal, documentId, "req_10");
  live = await payload(await guide.getPublicGuide(
    new Request("https://example.test/api/public/guide/freshman-transit"), e, "freshman-transit",
  ));
  assert.equal(live.content.cards[0].fareYuan, 6, "回滚后线上应恢复旧票价");
  assert.equal(live.revisionNo, 1);
});

test("publishing rejects a draft revision through the handler as well", async () => {
  const e = env(database());
  const created = await payload(await guide.createGuideDocument(
    jsonRequest({ slug: "freshman-transit", title: "指南" }), e, principal, "req_1",
  ));
  const saved = await payload(await guide.saveGuideRevision(
    jsonRequest({ title: "指南", content: content() }), e, principal, created.id, "req_2",
  ));

  await assert.rejects(
    guide.publishGuideRevision(jsonRequest({ revisionId: saved.id }), e, principal, created.id, "req_3"),
    /approved revision can be published/,
  );
});

// ---------------------------------------------------------------------------
// 公共读：草稿与待审内容不得外泄
// ---------------------------------------------------------------------------

test("an unpublished guide is not readable from the public side", async () => {
  const e = env(database());
  await approvedRevision(e);   // 审核通过但没发布
  await assert.rejects(
    guide.getPublicGuide(
      new Request("https://example.test/api/public/guide/freshman-transit"), e, "freshman-transit",
    ),
    /Published guide does not exist/,
  );
});

test("unpublishing takes the guide offline while keeping its history", async () => {
  const sqlite = database();
  const e = env(sqlite);
  const { documentId, revisionId } = await approvedRevision(e);
  await guide.publishGuideRevision(jsonRequest({ revisionId }), e, principal, documentId, "req_5");
  await guide.unpublishGuideDocument(e, principal, documentId, "req_6");

  await assert.rejects(
    guide.getPublicGuide(
      new Request("https://example.test/api/public/guide/freshman-transit"), e, "freshman-transit",
    ),
    /Published guide does not exist/,
  );
  const kept = sqlite.prepare("select count(*) as n from guide_revisions where document_id=?").get(documentId);
  assert.equal(kept.n, 1, "下线不该删历史");
});

test("content missing cards or hubs is refused", async () => {
  const e = env(database());
  const created = await payload(await guide.createGuideDocument(
    jsonRequest({ slug: "freshman-transit", title: "指南" }), e, principal, "req_1",
  ));
  await assert.rejects(
    guide.saveGuideRevision(
      jsonRequest({ title: "指南", content: { hubs: [] } }), e, principal, created.id, "req_2",
    ),
    /content\.cards must be an array/,
  );
  await assert.rejects(
    guide.saveGuideRevision(
      jsonRequest({ title: "指南", content: { cards: [] } }), e, principal, created.id, "req_3",
    ),
    /content\.hubs must be an array/,
  );
});

// ---------------------------------------------------------------------------
// SVG 消毒
// ---------------------------------------------------------------------------

function svgRequest(body) {
  return new Request("https://example.test/api/admin/guide/assets/fig?kind=figure_svg", {
    method: "PUT",
    headers: { "content-type": "image/svg+xml" },
    body,
  });
}

const UNSAFE_SVG = {
  "<script>": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "on* attribute": '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
  "javascript: URL": '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
  "<foreignObject>": '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><b/></foreignObject></svg>',
  "<iframe>": '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"/></svg>',
  "SMIL event": '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onload" to="alert(1)"/></svg>',
  "external reference": '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://evil.test/x.svg#a"/></svg>',
  "DOCTYPE entity": '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
  "html data URL": '<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,x"><rect/></a></svg>',
  "nested svg data URL": '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>',
};

for (const [label, body] of Object.entries(UNSAFE_SVG)) {
  test(`SVG upload rejects ${label}`, async () => {
    const e = env(database());
    await assert.rejects(
      guide.uploadGuideAsset(svgRequest(body), e, principal, "fig", "req_1"),
      (error) => {
        assert.match(String(error.message), /SVG|DOCTYPE|entities/i);
        return true;
      },
    );
  });
}

test("SVG upload accepts an embedded raster basemap", async () => {
  // 原稿图示的底图是置入的位图，导出时内联成 data:image/png —— 这是合法且必要的。
  // 早先「一律拒 data:」的规则会把全部真实原稿拒之门外。
  const e = env(database());
  const body =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 228 207">' +
    '<image x="0" y="0" width="1082" height="940" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="/>' +
    '<path d="M10 10 L20 20" stroke="#871c2b"/></svg>';
  const response = await guide.uploadGuideAsset(svgRequest(body), e, principal, "fig", "req_1");
  assert.equal(response.status, 201);
  const result = await payload(response);
  assert.equal(result.assetKey, "fig");
  assert.equal(result.metadata.viewBox, "0 0 228 207");
});

test("SVG upload is not fooled by a mention inside a comment", async () => {
  const e = env(database());
  const body =
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- 不要在这里放 <script> --><rect width="10" height="10"/></svg>';
  const response = await guide.uploadGuideAsset(svgRequest(body), e, principal, "fig", "req_1");
  assert.equal(response.status, 201);
});

test("asset keys are restricted to a URL-safe shape", async () => {
  const e = env(database());
  const body = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  for (const key of ["UPPER", "has_underscore", "x", "../etc/passwd", "trailing-"]) {
    await assert.rejects(
      guide.uploadGuideAsset(svgRequest(body), e, principal, key, "req_1"),
      /asset key must be/,
      `key "${key}" 应被拒`,
    );
  }
});

test("re-uploading the same key replaces the artwork without adding a second key", async () => {
  const sqlite = database();
  const e = env(sqlite);
  const first = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
  const second = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="2"/></svg>';

  const created = await guide.uploadGuideAsset(svgRequest(first), e, principal, "fig", "req_1");
  assert.equal(created.status, 201);
  const replaced = await guide.uploadGuideAsset(svgRequest(second), e, principal, "fig", "req_2");
  assert.equal(replaced.status, 200, "同 key 再传是替换而不是新建");

  const keys = sqlite.prepare("select count(*) as n from guide_assets").get();
  assert.equal(keys.n, 1);
  const meta = await payload(replaced);
  assert.equal(meta.metadata.viewBox, "0 0 20 20");

  // 旧的 media 行退休，公共读因此拿不到它
  const retired = sqlite.prepare("select count(*) as n from media_assets where status='deleted'").get();
  assert.equal(retired.n, 1);
});

// ---------------------------------------------------------------------------
// 素材读取的缓存契约与列表契约
//
// 这两条是编辑器直接依赖的形状，且都修过一次没测试锁住的 bug：
//   1. 素材 URL 按 asset_key 寻址，同键的图会被替换。曾用 immutable 缓存，
//      换图后一年内用户看到的都是旧图且刷新无效 —— 必须锁死
//      「must-revalidate + ETag、304 命中、换图后 ETag 变」这条契约。
//   2. 编辑器的图示下拉吃 listGuideAssets 的 assetKey / assetKind / metadata
//      三个字段，字段改名会让下拉静默清空。
// ---------------------------------------------------------------------------

function rasterRequest(body, contentType = "image/jpeg") {
  return new Request("https://example.test/api/admin/guide/assets/scene-photo?kind=figure_png", {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
}

test("uploaded JPEG scene photos can be read back from the public asset URL", async () => {
  // 编辑器按魔术字节收 JPEG（手机实景照的自然格式），曾只在读端放行 svg/png，
  // 结果 PUT 201、「已配图」写进草稿，预览却裂图。
  const e = env(database());
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const put = await guide.uploadGuideAsset(rasterRequest(jpeg), e, principal, "scene-photo", "req_1");
  assert.equal(put.status, 201);
  const created = await payload(put);
  assert.equal(created.contentType, "image/jpeg");

  const get = await guide.getPublicGuideAsset(
    new Request("https://example.test/api/public/guide-assets/scene-photo"),
    e,
    "scene-photo",
  );
  assert.equal(get.status, 200, "公开读必须放行已入库的 JPEG，不能 500 裂图");
  assert.equal(get.headers.get("content-type"), "image/jpeg");
});

test("asset responses revalidate instead of caching immutably", async () => {
  const sqlite = database();
  const e = env(sqlite);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
  await guide.uploadGuideAsset(svgRequest(svg), e, principal, "fig", "req_1");

  const url = "https://example.test/api/public/guide-assets/fig";
  const first = await guide.getPublicGuideAsset(new Request(url), e, "fig");
  assert.equal(first.status, 200);
  const cacheControl = first.headers.get("cache-control") || "";
  assert.ok(!/immutable/.test(cacheControl), "按键寻址的 URL 不得用 immutable，换图会一年不生效");
  assert.match(cacheControl, /must-revalidate/);
  const etag = first.headers.get("etag");
  assert.ok(etag, "必须带 ETag 供 revalidate 比对");

  const second = await guide.getPublicGuideAsset(
    new Request(url, { headers: { "if-none-match": etag } }), e, "fig",
  );
  assert.equal(second.status, 304, "未变更时命中 304");

  const changed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="2"/></svg>';
  await guide.uploadGuideAsset(svgRequest(changed), e, principal, "fig", "req_2");
  const third = await guide.getPublicGuideAsset(
    new Request(url, { headers: { "if-none-match": etag } }), e, "fig",
  );
  assert.equal(third.status, 200, "换图后旧 ETag 不得再命中 304");
  assert.notEqual(third.headers.get("etag"), etag, "换图后 ETag 必须变化");
});

test("listGuideAssets returns the shape the editor dropdown consumes", async () => {
  const e = env(database());
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
  await guide.uploadGuideAsset(svgRequest(svg), e, principal, "fig", "req_1");

  const res = await payload(await guide.listGuideAssets(e));
  assert.ok(Array.isArray(res.items));
  assert.equal(res.items.length, 1);
  const item = res.items[0];
  assert.equal(item.assetKey, "fig");
  assert.equal(item.assetKind, "figure_svg");
  assert.ok(item.metadata && typeof item.metadata === "object", "metadata 必须是解析后的对象");
  assert.equal(item.metadata.viewBox, "0 0 10 10");
});

test("deleting an asset still referenced by published content is refused", async () => {
  const sqlite = database();
  const e = env(sqlite);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
  await guide.uploadGuideAsset(svgRequest(svg), e, principal, "fig", "req_1");

  const { documentId, revisionId } = await approvedRevision(e, {
    cards: [{ id: "c1", kind: "figure", hub: "hongqiao", campus: "baoshan", figure: "fig", title: "图" }],
  });
  await guide.publishGuideRevision(
    jsonRequest({ revisionId }), e, principal, documentId, "req_5",
  );

  await assert.rejects(
    guide.deleteGuideAsset(e, principal, "fig", "req_6"),
    /still referenced/,
    "已发布内容引用的素材不得删除，否则前台出现空图框",
  );

  // 下线后不再被已发布内容引用，可以删
  await guide.unpublishGuideDocument(e, principal, documentId, "req_7");
  const res = await payload(await guide.deleteGuideAsset(e, principal, "fig", "req_8"));
  assert.equal(res.deleted, true);
});
