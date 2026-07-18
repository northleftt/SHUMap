import type { D1Database, D1PreparedStatement, D1Value } from "../types/cloudflare";

export async function all<T>(db: D1Database, sql: string, values: D1Value[] = []): Promise<T[]> {
  return (await statement(db, sql, values).all<T>()).results;
}

export async function first<T>(db: D1Database, sql: string, values: D1Value[] = []): Promise<T | null> {
  return statement(db, sql, values).first<T>();
}

export async function run(db: D1Database, sql: string, values: D1Value[] = []): Promise<void> {
  await statement(db, sql, values).run();
}

export function statement(db: D1Database, sql: string, values: D1Value[] = []): D1PreparedStatement {
  const prepared = db.prepare(sql);
  return values.length ? prepared.bind(...values) : prepared;
}

export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length) await db.batch(statements);
}

export async function assertExists(
  db: D1Database,
  table: string,
  id: string | null | undefined,
  label: string,
): Promise<void> {
  if (!id) return;
  if (!/^[a-z_]+$/.test(table)) throw new Error("Unsafe table name");
  const row = await first<{ id: string }>(db, `select id from ${table} where id = ?`, [id]);
  if (!row) throw new Error(`${label} does not exist`);
}
