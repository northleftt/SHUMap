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

/**
 * Tables whose primary key is not literally `id`. `buildings` is a 1:1 extension
 * of `places`, so its key is `place_id`; without this the existence check itself
 * fails with "no such column: id" (a 500) instead of validating the reference.
 */
const PRIMARY_KEY_COLUMNS: Record<string, string> = {
  buildings: "place_id",
};

export async function assertExists(
  db: D1Database,
  table: string,
  id: string | null | undefined,
  label: string,
): Promise<void> {
  if (!id) return;
  if (!/^[a-z_]+$/.test(table)) throw new Error("Unsafe table name");
  const keyColumn = PRIMARY_KEY_COLUMNS[table] ?? "id";
  const row = await first<Record<string, unknown>>(db, `select ${keyColumn} from ${table} where ${keyColumn} = ?`, [id]);
  if (!row) throw new Error(`${label} does not exist`);
}
