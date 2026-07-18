import type { Permission, SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first, run } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, makeId, requiredString, sha256 } from "../lib/values";

const SESSION_COOKIE = "shumap_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  permissions_json: string;
}

export async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_BOOTSTRAP_SECRET) {
    throw new HttpError(404, "not_found", "Bootstrap is not enabled");
  }
  const provided = request.headers.get("x-bootstrap-secret") ?? "";
  if (!(await constantTimeEqual(provided, env.ADMIN_BOOTSTRAP_SECRET))) {
    throw new HttpError(403, "forbidden", "Invalid bootstrap credential");
  }
  const count = await first<{ count: number }>(env.DB, "select count(*) as count from users");
  if ((count?.count ?? 0) > 0) throw new HttpError(409, "already_bootstrapped", "An owner already exists");

  const body = await readJson<Record<string, unknown>>(request);
  const email = normalizeEmail(requiredString(body.email, "email", 254));
  const displayName = requiredString(body.displayName, "displayName", 100);
  const password = requiredString(body.password, "password", 256);
  validatePassword(password);

  const userId = makeId("usr");
  const now = isoNow();
  const passwordHash = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare("insert into users(id,email,display_name,password_hash,status,created_at,updated_at) values(?,?,?,?, 'active',?,?)")
      .bind(userId, email, displayName, passwordHash, now, now),
    env.DB.prepare("insert into user_roles(user_id,role_id) values(?, 'owner')").bind(userId),
  ]);
  return json({ id: userId, email, displayName }, { status: 201 });
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const email = normalizeEmail(requiredString(body.email, "email", 254));
  const password = requiredString(body.password, "password", 256);
  const user = await first<UserRow>(
    env.DB,
    "select id,email,display_name,password_hash,status from users where email = ? collate nocase",
    [email],
  );
  if (!user || user.status !== "active" || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");
  }

  const rawToken = `${makeId("ses")}.${crypto.randomUUID()}`;
  const sessionId = makeId("session");
  const tokenHash = await sha256(`${rawToken}:${env.SESSION_PEPPER}`);
  const now = isoNow();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await run(
    env.DB,
    "insert into sessions(id,user_id,token_hash,expires_at,last_seen_at,created_at) values(?,?,?,?,?,?)",
    [sessionId, user.id, tokenHash, expiresAt, now, now],
  );
  return json(
    { user: { id: user.id, email: user.email, displayName: user.display_name }, expiresAt },
    { headers: { "set-cookie": sessionCookie(rawToken, SESSION_TTL_SECONDS) } },
  );
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const raw = getSessionToken(request);
  if (raw) {
    const tokenHash = await sha256(`${raw}:${env.SESSION_PEPPER}`);
    await run(env.DB, "update sessions set revoked_at = ? where token_hash = ?", [isoNow(), tokenHash]);
  }
  return json({ ok: true }, { headers: { "set-cookie": expiredSessionCookie() } });
}

export async function requireSession(request: Request, env: Env, permission?: Permission): Promise<SessionPrincipal> {
  const raw = getSessionToken(request);
  if (!raw) throw new HttpError(401, "unauthorized", "Authentication required");
  const tokenHash = await sha256(`${raw}:${env.SESSION_PEPPER}`);
  const rows = await all<SessionRow>(
    env.DB,
    `select s.id as session_id,u.id as user_id,u.email,u.display_name,r.permissions_json
       from sessions s
       join users u on u.id=s.user_id
       join user_roles ur on ur.user_id=u.id
       join roles r on r.id=ur.role_id
      where s.token_hash=? and s.revoked_at is null and s.expires_at>? and u.status='active'`,
    [tokenHash, isoNow()],
  );
  if (!rows.length) throw new HttpError(401, "unauthorized", "Session is invalid or expired");
  const permissions = Array.from(new Set(rows.flatMap((row) => JSON.parse(row.permissions_json) as Permission[])));
  if (permission && !permissions.includes("*") && !permissions.includes(permission)) {
    throw new HttpError(403, "forbidden", `Missing permission: ${permission}`);
  }
  const row = rows[0];
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    permissions,
  };
}

export async function handleSession(request: Request, env: Env): Promise<Response> {
  const principal = await requireSession(request, env);
  return json({ user: { id: principal.userId, email: principal.email, displayName: principal.displayName }, permissions: principal.permissions });
}

function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function normalizeEmail(email: string): string {
  const normalized = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new HttpError(400, "validation_error", "Invalid email address");
  return normalized;
}

function validatePassword(password: string): void {
  if (password.length < 12) throw new HttpError(400, "weak_password", "Password must be at least 12 characters");
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 310_000;
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltRaw, expectedRaw] = encoded.split("$");
  if (algorithm !== "pbkdf2-sha256") return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) return false;
  const salt = fromBase64(saltRaw);
  const expected = fromBase64(expectedRaw);
  const actual = await pbkdf2(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  return constantTimeBytes(actual, expected);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)));
  const rightHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)));
  return constantTimeBytes(leftHash, rightHash);
}

function constantTimeBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
