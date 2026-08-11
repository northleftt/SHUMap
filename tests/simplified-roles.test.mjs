// 角色精简的契约测试（migration 0021）。
//
// 为什么钉这个：角色清单由 roles 表种子驱动，管理端「新建账户」的角色下拉、
// assertAssignableRole 的可分配校验都直接读这张表。精简方案的约定是只剩三档 ——
// volunteer（仅写入，collect:data）、admin（管理员，除 manage:users 外的全部后台
// 权限）、owner（超级管理员，通配 *，唯一能做账号管理的角色）。权限字符串本身
// 不变，所以 worker 的端点 gate 都不用动；这里钉住迁移后的最终角色集，以及
// 老角色成员被并入 admin、user_roles 不因多角色冲突而留脏数据。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(read(`migrations-v2/${name}`));
  }
  return db;
}

test("after all migrations only volunteer/admin/owner roles remain", () => {
  const db = freshDatabase();
  const rows = db.prepare("select id,permissions_json from roles order by id").all();
  assert.deepEqual(
    rows.map((r) => r.id),
    ["admin", "owner", "volunteer"],
    "角色表应只剩 admin/owner/volunteer 三档",
  );
  const perms = Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.permissions_json)]));
  assert.deepEqual(perms.volunteer, ["collect:data"], "志愿者仍是仅写入（采集提交）");
  assert.deepEqual(perms.owner, ["*"], "超级管理员通配");
  assert.deepEqual(
    perms.admin.sort(),
    ["publish:release", "read:admin", "review:content", "rollback:release",
      "write:content", "write:maps", "write:transit"].sort(),
    "管理员拥有除 manage:users 外的全部后台权限",
  );
  assert.ok(!perms.admin.includes("manage:users"), "账号管理只归超级管理员");
  db.close();
});

test("members of retired roles are folded into admin without key conflicts", () => {
  const db = freshDatabase();
  // 重放精简前的状态：把 admin 行换回老角色，并造一个身兼两个老角色的账号
  db.exec(`
    insert into roles(id,name,permissions_json,created_at) values
      ('content_editor','Content editor','["read:admin","write:content"]',datetime('now')),
      ('reviewer','Reviewer','["read:admin","review:content"]',datetime('now'));
    insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at) values
      ('usr_multi','m@example.com','多角色','x','active',1,datetime('now'),datetime('now'));
    insert into user_roles(user_id,role_id) values
      ('usr_multi','content_editor'),('usr_multi','reviewer');
    delete from user_roles where role_id='admin';
    delete from roles where id='admin';
  `);
  db.exec(read("migrations-v2/0021_simplify_roles.sql"));
  const roles = db.prepare("select role_id from user_roles where user_id='usr_multi'").all();
  assert.deepEqual(roles.map((r) => r.role_id), ["admin"], "身兼两个老角色的账号应只落一行 admin");
  assert.equal(db.prepare("select count(*) as n from roles where id in ('viewer','content_editor','map_editor','transit_editor','reviewer','publisher')").get().n, 0,
    "老角色应从 roles 表删除");
  db.close();
});

test("admin console role labels match the three surviving roles", () => {
  const page = read("src/admin/pages/UsersPage.tsx");
  for (const [id, label] of [["owner", "超级管理员"], ["admin", "管理员"], ["volunteer", "志愿者"]]) {
    assert.ok(page.includes(`${id}: "${label}"`), `UsersPage 缺角色标签 ${id}: ${label}`);
  }
  for (const retired of ["content_editor", "map_editor", "transit_editor", "reviewer", "publisher", "viewer"]) {
    assert.ok(!page.includes(`${retired}:`), `UsersPage 不应再有 ${retired} 标签`);
  }
});
