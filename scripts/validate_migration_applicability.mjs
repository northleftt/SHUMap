#!/usr/bin/env node
// D1 applicability gate for migrations-v2/*.sql.
//
// The unit tests feed each migration to node:sqlite as a single exec() call.
// exec() has no authorizer and no statement splitter, so a migration can pass
// `npm test` and still be impossible to apply with `wrangler d1 migrations
// apply`. This gate reproduces the two things wrangler does that exec() does
// not: it splits the file with wrangler's own splitter, then checks each
// resulting statement against the limits D1's authorizer actually enforces.
//
// Every rule below was measured against a real local D1 (miniflare/workerd),
// not inferred:
//   create temporary table   -> SQLITE_AUTH
//   create table             -> ok
//   create trigger           -> ok (including a lowercase begin...end; body)
//   pragma foreign_keys = on -> ok
//   any other pragma         -> SQLITE_AUTH
//   attach / detach          -> SQLITE_AUTH
//   begin transaction/commit -> rejected
//   statement <= 100000 B    -> ok
//   statement >  100000 B    -> SQLITE_TOOBIG
//
// Deliberately NOT checked: lowercase begin/case/end. Wrangler's splitter opens
// a compound statement on /\s(BEGIN|CASE)\s$/i but closes it only on
// /\sEND[;\s]$/ (case sensitive), so lowercase bodies glue following statements
// together. Glued statements still execute in full — verified — so gluing is
// only a problem when it pushes a statement past the size limit, which the size
// rule already catches. 0001 ships lowercase bodies and is applied in
// production; flagging the casing would demand editing an applied migration.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery } from "wrangler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "migrations-v2");

/** The only pragma D1 accepts. */
const ALLOWED_PRAGMA = /^pragma\s+foreign_keys\s*=\s*on$/i;

/** SQLITE_MAX_SQL_LENGTH. 100000 applies; 102400 fails with SQLITE_TOOBIG. */
const MAX_STATEMENT_BYTES = 100_000;

/**
 * SQLITE_MAX_COMPOUND_SELECT. Measured against local D1: 5 terms apply, 6 fail
 * with "too many terms in compound SELECT". The limit also applies inside
 * subqueries, so nesting a union does not evade it.
 */
const MAX_COMPOUND_SELECT = 5;

const failures = [];

/** Blank out comments and string literals so keyword scanning sees only code. */
function stripNonCode(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += " ".repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const end = sql.indexOf(char, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      // Keep newlines so line numbers stay accurate.
      out += sql.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** 1-based line number of a byte offset, so failures are actionable. */
function lineOf(sql, index) {
  let line = 1;
  for (let i = 0; i < index && i < sql.length; i += 1) {
    if (sql[i] === "\n") line += 1;
  }
  return line;
}

for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const file = path.join(dir, name);
  const relative = path.relative(root, file);
  const raw = readFileSync(file, "utf8");
  const code = stripNonCode(raw);

  const record = (index, message) => {
    failures.push(`${relative}:${lineOf(code, index)} ${message}`);
  };

  for (const match of code.matchAll(/\bcreate\s+(temporary|temp)\s+table\b/gi)) {
    record(
      match.index,
      `"create ${match[1]} table" is rejected by the D1 authorizer (SQLITE_AUTH). Use a plain table and drop it before the migration ends.`,
    );
  }

  for (const match of code.matchAll(/\bpragma\b[^;]*/gi)) {
    const statement = match[0].trim().replace(/\s+/g, " ");
    if (ALLOWED_PRAGMA.test(statement)) continue;
    record(match.index, `pragma "${statement}" is rejected by the D1 authorizer. Only "pragma foreign_keys = on" is allowed.`);
  }

  for (const match of code.matchAll(/\b(attach|detach)\b/gi)) {
    record(match.index, `"${match[1]}" is rejected by the D1 authorizer.`);
  }

  for (const match of code.matchAll(/\b(begin\s+transaction|commit|rollback|savepoint|release\s+savepoint)\b/gi)) {
    record(match.index, `explicit transaction control ("${match[0].replace(/\s+/g, " ")}") is rejected by D1.`);
  }

  for (const match of code.matchAll(/\b(insert\s+into|update|delete\s+from)\s+sqlite_master\b/gi)) {
    record(match.index, "writing to sqlite_master is rejected by D1.");
  }

  // D1 caps a compound SELECT at MAX_COMPOUND_SELECT terms, inside subqueries
  // as well as at the top level. Walk the statement tracking paren depth: each
  // parenthesised group is its own compound scope, so sibling subqueries do not
  // pool their terms. Statement boundaries reset the outermost scope.
  {
    const scopes = [{ terms: 1, index: 0 }];
    const closeScope = (scope) => {
      if (scope.terms <= MAX_COMPOUND_SELECT) return;
      record(
        scope.index,
        `compound SELECT has ${scope.terms} terms (limit ${MAX_COMPOUND_SELECT}) — D1 rejects it with "too many terms in compound SELECT". Split it into separate statements.`,
      );
    };
    for (let i = 0; i < code.length; i += 1) {
      const char = code[i];
      if (char === "(") {
        scopes.push({ terms: 1, index: i });
        continue;
      }
      if (char === ")") {
        if (scopes.length > 1) closeScope(scopes.pop());
        continue;
      }
      if (char === ";" && scopes.length === 1) {
        closeScope(scopes[0]);
        scopes[0] = { terms: 1, index: i };
        continue;
      }
      const rest = code.slice(i, i + 9);
      const compound = /^(union|except|intersect)\b/i.exec(rest);
      if (compound && !/[A-Za-z0-9_]/.test(code[i - 1] ?? " ")) {
        const scope = scopes.at(-1);
        if (scope.terms === 1) scope.index = i;
        scope.terms += 1;
        i += compound[1].length - 1;
      }
    }
    closeScope(scopes[0]);
  }

  // Split exactly the way wrangler will, then size-check each statement.
  for (const statement of unstable_splitSqlQuery(raw)) {
    const bytes = Buffer.byteLength(statement, "utf8");
    if (bytes <= MAX_STATEMENT_BYTES) continue;
    const head = statement.slice(0, 70).replace(/\s+/g, " ");
    failures.push(
      `${relative} produces a ${bytes}-byte statement (limit ${MAX_STATEMENT_BYTES}) starting "${head}…" — D1 rejects it with SQLITE_TOOBIG. Split the values list, and uppercase BEGIN/CASE/END in trigger bodies so wrangler's splitter stops gluing statements onto it.`,
    );
  }
}

const total = readdirSync(dir).filter((f) => f.endsWith(".sql")).length;

if (failures.length > 0) {
  console.error("migration applicability check failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`\n${failures.length} problem(s). These files cannot be applied by "wrangler d1 migrations apply".`);
  process.exit(1);
}

console.log(`migration applicability validated: ${total} files apply cleanly under wrangler's splitter and the D1 authorizer`);
