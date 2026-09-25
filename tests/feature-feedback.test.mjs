// 功能评分反馈：纯运营数据，匿名可提交，与内容反馈（content_submissions）彻底分开。
//
// 这条边界是产品决定，用测试钉住三件事：
//   1. 提交门槛为零（匿名、无会话），但 rating 必须是 1-5 的整数——
//      平均分是这张表唯一的用途，混进脏值整个功能就废了；
//   2. page 是自由分组键（长度约束而非枚举），新页面挂入口不需要改库；
//   3. 管理端列表的 page/rating 过滤在服务端生效，过滤参数写错要 400 而不是静默忽略。

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
      export { submitFeatureFeedback, listFeatureFeedback } from "./worker/modules/feature-feedback.ts";
    `,
    resolveDir: root,
    sourcefile: "feature-feedback-entry.ts",
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

function freshDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((n) => n.endsWith(".sql")).sort()) {
    sqlite.exec(read(`migrations-v2/${name}`));
  }
  return sqlite;
}

/** 评分提交请求：匿名（无 cookie），带出口 IP 让限流桶按 IP 计数。 */
function feedbackRequest(body, ip = "203.0.113.7") {
  return new Request("https://example.test/api/public/feature-feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

function adminListRequest(query = "") {
  return new Request(`https://example.test/api/admin/feature-feedback${query}`);
}

async function assertValidationError(promise) {
  await assert.rejects(() => promise, (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "validation_error");
    return true;
  });
}

test("a valid rating is stored anonymously, with or without a reason", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  const low = await handlers.submitFeatureFeedback(
    feedbackRequest({ page: "search", rating: 2, reason: "搜不到想去的楼" }),
    env,
  );
  assert.equal(low.status, 204);

  const high = await handlers.submitFeatureFeedback(
    feedbackRequest({ page: "shuttle", rating: 5 }),
    env,
  );
  assert.equal(high.status, 204);

  // 同毫秒插入时 created_at 并列，顺序不稳定；按 page 作第二排序键保证确定顺序。
  const rows = sqlite.prepare("select page, rating, reason from feature_feedback order by created_at, page").all();
  assert.equal(rows.length, 2);
  // node:sqlite 的行是 null-prototype 对象，逐字段比而不是 deepEqual 整个字面量。
  assert.equal(rows[0].page, "search");
  assert.equal(rows[0].rating, 2);
  assert.equal(rows[0].reason, "搜不到想去的楼");
  assert.equal(rows[1].page, "shuttle");
  assert.equal(rows[1].rating, 5);
  assert.equal(rows[1].reason, null);
  sqlite.close();
});

test("rating must be an integer between 1 and 5", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  for (const rating of [0, 6, 2.5, "4", true]) {
    await assertValidationError(handlers.submitFeatureFeedback(feedbackRequest({ page: "search", rating }), env));
  }
  assert.equal(sqlite.prepare("select count(*) as count from feature_feedback").get().count, 0);
  sqlite.close();
});

test("page is a free-form grouping key bounded only by length", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  // 未知 page 也接受：挂新入口不该要求改库，库里只有长度约束（1-50）。
  const response = await handlers.submitFeatureFeedback(
    feedbackRequest({ page: "some-future-page", rating: 4 }),
    env,
  );
  assert.equal(response.status, 204);

  await assertValidationError(handlers.submitFeatureFeedback(feedbackRequest({ rating: 4 }), env));
  await assertValidationError(handlers.submitFeatureFeedback(feedbackRequest({ page: "", rating: 4 }), env));
  await assertValidationError(handlers.submitFeatureFeedback(feedbackRequest({ page: "x".repeat(51), rating: 4 }), env));
  sqlite.close();
});

test("reason is optional at any rating but capped at 500 characters", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  // 高分也允许附原因——「低分必填原因」只是前端引导，不是服务端规则。
  const response = await handlers.submitFeatureFeedback(
    feedbackRequest({ page: "shuttle", rating: 5, reason: "希望能加实时到站" }),
    env,
  );
  assert.equal(response.status, 204);

  await assertValidationError(
    handlers.submitFeatureFeedback(feedbackRequest({ page: "shuttle", rating: 2, reason: "长".repeat(501) }), env),
  );
  sqlite.close();
});

test("request bodies are whitelisted: unknown fields are rejected", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  await assertValidationError(
    handlers.submitFeatureFeedback(feedbackRequest({ page: "search", rating: 4, campus: "baoshan" }), env),
  );
  sqlite.close();
});

test("the admin list filters by page and rating, newest first", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  await handlers.submitFeatureFeedback(feedbackRequest({ page: "search", rating: 5 }), env);
  await handlers.submitFeatureFeedback(feedbackRequest({ page: "search", rating: 2, reason: "结果不准" }), env);
  await handlers.submitFeatureFeedback(feedbackRequest({ page: "shuttle", rating: 2 }), env);
  await handlers.submitFeatureFeedback(feedbackRequest({ page: "shuttle", rating: 4 }), env);

  const allItems = (await (await handlers.listFeatureFeedback(adminListRequest(), env)).json()).items;
  assert.equal(allItems.length, 4);
  // 字段是 camelCase，时间倒序。
  assert.ok(allItems[0].createdAt >= allItems[3].createdAt);
  assert.ok(Object.hasOwn(allItems[0], "createdAt"));

  const searchOnly = (await (await handlers.listFeatureFeedback(adminListRequest("?page=search"), env)).json()).items;
  assert.equal(searchOnly.length, 2);
  assert.ok(searchOnly.every((item) => item.page === "search"));

  const ratingTwo = (await (await handlers.listFeatureFeedback(adminListRequest("?rating=2"), env)).json()).items;
  assert.equal(ratingTwo.length, 2);
  assert.ok(ratingTwo.every((item) => item.rating === 2));

  const combined = (await (await handlers.listFeatureFeedback(adminListRequest("?page=shuttle&rating=2"), env)).json()).items;
  assert.equal(combined.length, 1);
  assert.equal(combined[0].page, "shuttle");
  assert.equal(combined[0].rating, 2);
  sqlite.close();
});

test("an invalid rating filter is a 400, not silently ignored", async () => {
  const sqlite = freshDatabase();
  const env = { DB: new D1Database(sqlite) };

  for (const query of ["?rating=0", "?rating=6", "?rating=abc"]) {
    await assertValidationError(handlers.listFeatureFeedback(adminListRequest(query), env));
  }
  sqlite.close();
});

test("the router exposes the public submit and admin list endpoints", () => {
  const worker = read("worker/index-v2.ts");
  // 公共提交：不挂会话（与 /api/analytics/events 同型），运营数据不需要身份。
  assert.match(worker, /method === "POST" && path === "\/api\/public\/feature-feedback"\) return submitFeatureFeedback/);
  // 管理端列表：read:admin 即可，没有审核动作。
  assert.match(worker, /path === "\/api\/admin\/feature-feedback"[\s\S]{0,160}?requireSession\(request, env, "read:admin"\)/);
});
