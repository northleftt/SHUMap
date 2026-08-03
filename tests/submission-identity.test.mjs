// 供稿身份：反馈可匿名也可署名，志愿者采集必须登录。
//
// 这条边界是产品决定，不是实现细节，所以用测试钉住：匿名反馈一旦被误加鉴权，
// 路过的人就再也报不了错误信息；反过来采集一旦放开，采集数据就失去追责能力。

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
      export { createSubmission, listSubmissions } from "./worker/modules/submissions.ts";
      export { optionalSession, requireSession } from "./worker/modules/auth.ts";
    `,
    resolveDir: root,
    sourcefile: "submission-identity-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const handlers = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

class Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.database.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("begin");
    try {
      for (const statement of statements) this.database.prepare(statement.sql).run(...statement.values);
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

const now = "2026-08-03T00:00:00.000Z";

function freshDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((n) => n.endsWith(".sql")).sort()) {
    sqlite.exec(read(`migrations-v2/${name}`));
  }
  sqlite.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_volunteer','vol@example.test','志愿者小王','hash','active',1,?,?)`,
  ).run(now, now);
  // 一个可作为反馈目标的地点 + 它的当前修订（baseRevisionId 必须与之一致）。
  sqlite.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
     values('place_target','building','campus_baoshan','active',?,?)`,
  ).run(now, now);
  sqlite.prepare(
    `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,content_json,structure_json,
       content_hash,created_at)
     values('prev_target','place_target',1,'approved','测试楼','{"detail":{"facts":[],"media":[]}}',
       '{"kindId":"building","campusId":"campus_baoshan","parentPlaceId":null,"stableCode":null,"aliases":[],"building":null,"locations":[]}',
       'hash',?)`,
  ).run(now);
  sqlite.prepare("update places set current_revision_id='prev_target' where id='place_target'").run();
  return sqlite;
}

/** 反馈请求体：7 个字段都必须在（exactObject）。 */
function feedbackRequest(overrides = {}) {
  return new Request("https://example.test/api/public/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({
      targetType: "place",
      targetId: "place_target",
      baseRevisionId: "prev_target",
      payload: { submissionKind: "feedback", feedbackType: "correction", description: "开放时间已经变了" },
      submitterName: null,
      submitterContact: null,
      photoMediaIds: [],
      ...overrides,
    }),
  });
}

const volunteer = {
  sessionId: "session_1",
  userId: "user_volunteer",
  email: "vol@example.test",
  displayName: "志愿者小王",
  permissions: ["collect:data"],
};

test("anonymous feedback is accepted and stored without an account", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  const response = await handlers.createSubmission(feedbackRequest(), env, null);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.status, "pending");
  // 明确告知调用方这条提交无法溯源，前端据此提示「登录后可跟进」。
  assert.equal(body.attributed, false);

  const row = sqlite.prepare("select submitter_user_id, submitter_name from content_submissions where id=?").get(body.id);
  assert.equal(row.submitter_user_id, null);
  assert.equal(row.submitter_name, null);
  sqlite.close();
});

test("signed-in feedback records the account and falls back to its display name", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  const response = await handlers.createSubmission(feedbackRequest(), env, volunteer);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.attributed, true);

  const row = sqlite.prepare("select submitter_user_id, submitter_name from content_submissions where id=?").get(body.id);
  assert.equal(row.submitter_user_id, "user_volunteer");
  // submitterName 留空时回落到账号名，而不是写一个空串。
  assert.equal(row.submitter_name, "志愿者小王");
  sqlite.close();
});

test("a self-declared nickname never overrides the account the submission is attributed to", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  const response = await handlers.createSubmission(
    feedbackRequest({ submitterName: "校长本人" }),
    env,
    volunteer,
  );
  const body = await response.json();
  const row = sqlite.prepare("select submitter_user_id, submitter_name from content_submissions where id=?").get(body.id);
  // 昵称照原样保留（展示用），但归属仍是会话里的真实账号。
  assert.equal(row.submitter_name, "校长本人");
  assert.equal(row.submitter_user_id, "user_volunteer");
  sqlite.close();
});

test("the review list distinguishes an attributable submission from an anonymous one", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  const signed = await (await handlers.createSubmission(feedbackRequest(), env, volunteer)).json();
  const anonymous = await (await handlers.createSubmission(feedbackRequest(), env, null)).json();

  const payload = await (await handlers.listSubmissions(env)).json();
  const signedRow = payload.items.find((item) => item.id === signed.id);
  const anonymousRow = payload.items.find((item) => item.id === anonymous.id);

  // 审核端看到的是账号邮箱与真名，而不是只有一个可以随便填的自称。
  assert.equal(signedRow.submitterUserId, "user_volunteer");
  assert.equal(signedRow.submitterEmail, "vol@example.test");
  assert.equal(signedRow.submitterAccountName, "志愿者小王");

  assert.equal(anonymousRow.submitterUserId, null);
  assert.equal(anonymousRow.submitterEmail, null);
  sqlite.close();
});

test("optionalSession treats a missing or invalid cookie as anonymous instead of failing", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite), SESSION_PEPPER: "pepper" };

  const noCookie = new Request("https://example.test/api/public/submissions", { method: "POST" });
  assert.equal(await handlers.optionalSession(noCookie, env), null);

  // 过期 / 伪造的 cookie 同样视同匿名：带着失效会话来提反馈不该被拦住。
  const staleCookie = new Request("https://example.test/api/public/submissions", {
    method: "POST",
    headers: { cookie: "shumap_session=ses_nonexistent.0000" },
  });
  assert.equal(await handlers.optionalSession(staleCookie, env), null);

  // 同一个请求走 requireSession 则必须 401——两个入口的语义不能混。
  await assert.rejects(() => handlers.requireSession(staleCookie, env), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
  sqlite.close();
});

test("the router keeps feedback open and collection gated", () => {
  const worker = read("worker/index-v2.ts");

  // 反馈与照片上传：optionalSession，不得是 requireSession。
  for (const route of ["/api/public/submissions", "/api/public/media"]) {
    const at = worker.indexOf(`path === "${route}"`);
    assert.ok(at > 0, `${route} must be routed`);
    const block = worker.slice(at, at + 200);
    assert.match(block, /optionalSession\(request, env\)/, `${route} must allow anonymous callers`);
    assert.doesNotMatch(block, /requireSession/, `${route} must not force a login`);
  }

  // 采集四个端点：必须是 requireSession + collect:data。
  const collectionRoutes = worker.match(/collection-tasks[\s\S]{0,240}?requireSession\(request, env, "collect:data"\)/g);
  assert.equal(collectionRoutes?.length, 4, "all four collection endpoints must require collect:data");
});

test("volunteer collection submissions always carry the collecting account", () => {
  const collections = read("worker/modules/collections.ts");
  // 采集提交的 submitter_user_id 取自任务行的领取账号，不是请求体。
  assert.match(collections, /submitter_user_id/);
  assert.match(collections, /ct\.assignee_user_id/);
});
