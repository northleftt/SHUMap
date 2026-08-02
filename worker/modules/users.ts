import { PERMISSIONS, type Permission, type SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, makeId, oneOf, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";
import { hashPassword, normalizeEmail, validatePassword } from "./auth";

// ---------------------------------------------------------------------------
// 账户管理。两类账户:管理角色(owner 之外的既有角色)与志愿者(volunteer)。
// 权限模型仍由 roles.permissions_json 决定,这里只负责账户的增改与角色绑定。
//
// 注意:sessions.token_version 在代码里没有任何消费方,因此禁用/改密时必须显式
// 写 sessions.revoked_at,不能依赖版本号失效旧会话。
// ---------------------------------------------------------------------------

/** owner 只能通过 bootstrap 或既有 owner 之间的手工调整产生,不在可分配列表里。 */
const PROTECTED_ROLE = "owner";

const USER_STATUSES = ["active", "disabled"] as const;
type UserStatus = (typeof USER_STATUSES)[number];

interface UserListRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  roleIds: string | null;
}

interface RoleRow {
  id: string;
  name: string;
  permissions_json: string;
}

interface CreateUserBody {
  email?: unknown;
  displayName?: unknown;
  password?: unknown;
  roleId?: unknown;
}

interface UpdateUserBody {
  displayName?: unknown;
  status?: unknown;
  password?: unknown;
  roleId?: unknown;
}

export async function listUsers(env: Env): Promise<Response> {
  const [users, roles] = await Promise.all([
    all<UserListRow>(
      env.DB,
      `select u.id,u.email,u.display_name as displayName,u.status,u.created_at as createdAt,u.updated_at as updatedAt,
              group_concat(ur.role_id) as roleIds
         from users u left join user_roles ur on ur.user_id = u.id
        group by u.id
        order by u.created_at`,
    ),
    listRoles(env),
  ]);
  return json({
    items: users.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      status: row.status,
      roles: splitRoleIds(row.roleIds),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    roles: roles.map((role) => ({
      id: role.id,
      name: role.name,
      permissions: parsePermissions(role.permissions_json),
      assignable: role.id !== PROTECTED_ROLE,
    })),
  });
}

export async function createUser(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<CreateUserBody>(request);
  const email = normalizeEmail(requiredString(body.email, "email", 254));
  const displayName = requiredString(body.displayName, "displayName", 100);
  const password = requiredString(body.password, "password", 256);
  validatePassword(password);
  const roleId = await assertAssignableRole(env, body.roleId);

  const existing = await first<{ id: string }>(env.DB, "select id from users where email = ? collate nocase", [email]);
  if (existing) throw new HttpError(409, "email_taken", "An account with this email already exists");

  const userId = makeId("usr");
  const now = isoNow();
  const passwordHash = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare(
      "insert into users(id,email,display_name,password_hash,status,created_at,updated_at) values(?,?,?,?,'active',?,?)",
    ).bind(userId, email, displayName, passwordHash, now, now),
    env.DB.prepare("insert into user_roles(user_id,role_id) values(?,?)").bind(userId, roleId),
  ]);
  await audit(env, principal, "user.create", "user", userId, requestId, null, { email, displayName, roleId });
  return json({ id: userId, email, displayName, status: "active", roles: [roleId], createdAt: now }, { status: 201 });
}

export async function updateUser(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  userId: string,
  requestId: string,
): Promise<Response> {
  const body = await readJson<UpdateUserBody>(request);
  const target = await first<{ id: string; email: string; display_name: string; status: string }>(
    env.DB,
    "select id,email,display_name,status from users where id = ?",
    [userId],
  );
  if (!target) throw new HttpError(404, "not_found", "Account does not exist");
  const currentRoles = splitRoleIds(
    (await first<{ roleIds: string | null }>(
      env.DB,
      "select group_concat(role_id) as roleIds from user_roles where user_id = ?",
      [userId],
    ))?.roleIds ?? null,
  );

  const displayName = body.displayName === undefined ? null : requiredString(body.displayName, "displayName", 100);
  const status = body.status === undefined ? null : oneOf<UserStatus>(body.status, "status", USER_STATUSES);
  const password = optionalString(body.password, "password", 256);
  const roleId = body.roleId === undefined ? null : await assertAssignableRole(env, body.roleId);
  if (password !== null) validatePassword(password);
  if (displayName === null && status === null && password === null && roleId === null) {
    throw new HttpError(400, "validation_error", "Nothing to update");
  }

  const isSelf = target.id === principal.userId;
  if (isSelf && status === "disabled") {
    throw new HttpError(409, "self_disable_forbidden", "You cannot disable your own account");
  }
  // 自己降级同样会立刻失去后台入口,即使系统里还有别的 owner,也拦下来。
  if (isSelf && roleId !== null && !currentRoles.includes(roleId)) {
    throw new HttpError(409, "self_role_change_forbidden", "You cannot change your own role");
  }

  const wasOwner = currentRoles.includes(PROTECTED_ROLE);
  const losesOwner = wasOwner && (status === "disabled" || (roleId !== null && roleId !== PROTECTED_ROLE));
  if (losesOwner) {
    const owners = await first<{ count: number }>(
      env.DB,
      `select count(*) as count from user_roles ur join users u on u.id = ur.user_id
        where ur.role_id = ? and u.status = 'active'`,
      [PROTECTED_ROLE],
    );
    if (!owners || !Number.isInteger(owners.count) || owners.count < 1) {
      throw new Error("Could not determine the number of active owner accounts");
    }
    if (owners.count === 1) {
      throw new HttpError(409, "last_owner_protected", "The last active owner account cannot be disabled or demoted");
    }
  }

  const now = isoNow();
  const statements = [];
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (displayName !== null) {
    sets.push("display_name = ?");
    values.push(displayName);
  }
  if (status !== null) {
    sets.push("status = ?");
    values.push(status);
  }
  if (password !== null) {
    sets.push("password_hash = ?");
    values.push(await hashPassword(password));
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    values.push(now, userId);
    statements.push(env.DB.prepare(`update users set ${sets.join(", ")} where id = ?`).bind(...values));
  }
  if (roleId !== null && !(currentRoles.length === 1 && currentRoles[0] === roleId)) {
    statements.push(env.DB.prepare("delete from user_roles where user_id = ?").bind(userId));
    statements.push(env.DB.prepare("insert into user_roles(user_id,role_id) values(?,?)").bind(userId, roleId));
  }
  // 禁用与改密必须踢掉已签发的会话;角色变化不需要,因为 requireSession 每次请求
  // 都重新 join roles 取权限。
  const revokeSessions = status === "disabled" || password !== null;
  if (revokeSessions) {
    statements.push(
      env.DB.prepare("update sessions set revoked_at = ? where user_id = ? and revoked_at is null").bind(now, userId),
    );
  }
  if (statements.length) await env.DB.batch(statements);

  await audit(
    env,
    principal,
    "user.update",
    "user",
    userId,
    requestId,
    { status: target.status, displayName: target.display_name, roles: currentRoles },
    {
      status: status ?? target.status,
      displayName: displayName ?? target.display_name,
      roles: roleId === null ? currentRoles : [roleId],
      passwordReset: password !== null,
      sessionsRevoked: revokeSessions,
    },
  );

  return json({
    id: userId,
    email: target.email,
    displayName: displayName ?? target.display_name,
    status: status ?? target.status,
    roles: roleId === null ? currentRoles : [roleId],
    sessionsRevoked: revokeSessions,
  });
}

async function listRoles(env: Env): Promise<RoleRow[]> {
  return all<RoleRow>(env.DB, "select id,name,permissions_json from roles order by id");
}

async function assertAssignableRole(env: Env, value: unknown): Promise<string> {
  const roleId = requiredString(value, "roleId", 80);
  if (roleId === PROTECTED_ROLE) {
    throw new HttpError(403, "role_not_assignable", "The owner role cannot be assigned here");
  }
  const role = await first<{ id: string }>(env.DB, "select id from roles where id = ?", [roleId]);
  if (!role) throw new HttpError(400, "validation_error", "roleId does not exist");
  return role.id;
}

function splitRoleIds(value: string | null): string[] {
  if (value === null) return [];
  const roleIds = value.split(",");
  if (roleIds.some((roleId) => roleId.length === 0)) {
    throw new Error("users.roleIds contains an empty role id");
  }
  if (new Set(roleIds).size !== roleIds.length) {
    throw new Error("users.roleIds contains duplicate role ids");
  }
  return roleIds;
}

function parsePermissions(value: string): Permission[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("roles.permissions_json must contain an array");
  const allowed = new Set<Permission>([...PERMISSIONS, "*"]);
  const permissions = parsed.map((permission, index) => {
    if (typeof permission !== "string" || !allowed.has(permission as Permission)) {
      throw new Error(`roles.permissions_json[${index}] contains an unknown permission`);
    }
    return permission as Permission;
  });
  if (new Set(permissions).size !== permissions.length) {
    throw new Error("roles.permissions_json contains duplicate permissions");
  }
  return permissions;
}
