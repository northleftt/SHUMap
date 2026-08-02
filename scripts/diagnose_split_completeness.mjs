#!/usr/bin/env node
// Check that every statement wrangler's splitter produces is complete SQL.
//
// `wrangler d1 migrations apply --remote` posts each split statement to the D1
// HTTP API, which parses it on its own. A statement the splitter cut in half is
// rejected with "incomplete input" (SQLITE_ERROR 7500). Locally the same file
// can succeed, because miniflare tolerates a glued blob that still happens to
// tokenize. So completeness has to be checked directly, not inferred from a
// successful local apply.
//
// node:sqlite raises "incomplete input" during parse, before it resolves table
// names, so an unknown table is reported separately and is not a failure here.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery } from "wrangler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "migrations-v2");
const only = process.argv[2];

const db = new DatabaseSync(":memory:");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let problems = 0;

for (const name of files) {
  if (only && name !== only) continue;
  const raw = readFileSync(path.join(dir, name), "utf8");
  const parts = unstable_splitSqlQuery(raw);
  const bad = [];
  for (const [index, statement] of parts.entries()) {
    try {
      db.prepare(statement);
    } catch (error) {
      const message = String(error.message);
      // Only parse-level truncation matters; unresolved names are expected.
      if (/incomplete input|unrecognized token|syntax error/i.test(message)) {
        bad.push({ index: index + 1, message, head: statement.slice(0, 90).replace(/\s+/g, " ") });
      }
    }
  }
  const flag = bad.length ? "FAIL" : "ok  ";
  console.log(`${flag} ${name}: ${parts.length} statement(s)`);
  for (const entry of bad) {
    problems += 1;
    console.log(`     #${entry.index} ${entry.message}`);
    console.log(`        ${entry.head}…`);
  }
}

db.close();
process.exit(problems > 0 ? 1 : 0);
