#!/usr/bin/env node
// Verify every migration survives the statement splitter that D1 applies on the
// REMOTE path, which is the one that decides whether a deploy works.
//
// `wrangler d1 migrations apply --remote` posts the whole migration file to the
// D1 /query API as a single `sql` field. The server splits it. That splitter
// increments its nesting depth on BEGIN but not on CASE, while decrementing on
// every END — so a CASE inside a trigger body closes the body early with its own
// END, the following `;` cuts the statement in half, and the API answers
// "incomplete input" (SQLITE_ERROR 7500). Measured on a throwaway remote
// database: a 255-byte file with `BEGIN SELECT CASE WHEN c THEN RAISE(...) END;
// END;` fails, while `BEGIN SELECT 1; END;` and
// `BEGIN SELECT RAISE(...) WHERE c; END;` both apply.
//
// Two things make this check non-trivial, and an earlier version of this script
// got both wrong:
//
//   1. node:sqlite's prepare() compiles only the FIRST statement of its input
//      and silently ignores whatever follows, so `prepare("select 1; garbage((")
//      succeeds. Truncation at the tail of a chunk is therefore invisible to
//      prepare() alone. Each chunk has to be executed, not just prepared.
//   2. A trigger references tables created by earlier statements, so checking a
//      chunk against an empty database reports "no such table" and hides the
//      parse error underneath. Chunks have to run in order, against a database
//      that already holds every preceding migration.
//
// So this script replays the whole migration chain chunk by chunk, splitting the
// way the server does. A migration that cannot be applied remotely fails here.
//
// Run with --self-test to check the detector itself against a known-bad and a
// known-good trigger body.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "migrations-v2");

/** Errors SQLite raises while parsing, as opposed to while resolving names. */
const PARSE_ERROR = /incomplete input|unrecognized token|syntax error|near ".*": syntax/i;

/**
 * Split `sql` the way D1's server-side splitter does.
 *
 * Depth rises on BEGIN and falls on END. CASE does not raise it — that
 * asymmetry is the defect being modelled, not an oversight here. A `;` at depth
 * zero ends a statement.
 */
export function serverSplit(sql) {
  const chunks = [];
  let current = "";
  let depth = 0;
  let word = "";

  const flushWord = () => {
    if (!word) return;
    const upper = word.toUpperCase();
    if (upper === "BEGIN") depth += 1;
    else if (upper === "END" && depth > 0) depth -= 1;
    word = "";
  };

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (char === "-" && sql[i + 1] === "-") {
      flushWord();
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (char === "/" && sql[i + 1] === "*") {
      flushWord();
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      flushWord();
      const end = sql.indexOf(char, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      word += char;
      current += char;
      continue;
    }

    flushWord();

    if (char === ";" && depth === 0) {
      current += char;
      chunks.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  flushWord();
  if (current.trim()) chunks.push(current);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

/**
 * Execute every chunk of `sql` in order against `db`, reporting the chunks the
 * parser rejects. Executing rather than preparing is what catches truncation at
 * the tail of a chunk.
 */
export function parseFailures(db, sql) {
  const failures = [];
  for (const [index, chunk] of serverSplit(sql).entries()) {
    try {
      db.exec(chunk);
    } catch (error) {
      const message = String(error.message);
      if (PARSE_ERROR.test(message)) {
        failures.push({ index: index + 1, message, head: chunk.slice(0, 90).replace(/\s+/g, " ") });
      }
      // Anything else is a runtime error (a guard tripping, a name that a later
      // chunk defines). Those are not splitter problems, so they are ignored
      // here; validate_v2_schema.mjs and the unit tests cover them.
    }
  }
  return failures;
}

const KNOWN_BAD = `
create table probe (id integer primary key, n integer not null);
create trigger probe_case_guard
before insert on probe
when new.n < 0
BEGIN
  select CASE WHEN new.n < -100 THEN raise(abort,'too negative') END;
END;
`;

const KNOWN_GOOD = `
create table probe (id integer primary key, n integer not null);
create trigger probe_where_guard
before insert on probe
when new.n < 0
BEGIN
  select raise(abort,'too negative') WHERE new.n < -100;
END;
`;

function selfTest() {
  let bad = 0;
  const check = (label, sql, shouldDetect) => {
    const db = new DatabaseSync(":memory:");
    const failures = parseFailures(db, sql);
    db.close();
    const detected = failures.length > 0;
    if (detected !== shouldDetect) bad += 1;
    console.log(`  ${detected === shouldDetect ? "OK  " : "FAIL"} ${label} (chunks rejected: ${failures.length})`);
  };
  console.log("self-test:");
  check("CASE inside a trigger body is detected", KNOWN_BAD, true);
  check("the WHERE-clause guard is accepted", KNOWN_GOOD, false);
  return bad;
}

/** Check one SQL string in isolation. Exported so a caller can test fixtures. */
export function chunkFailures(sql) {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = off");
  try {
    return parseFailures(db, sql);
  } finally {
    db.close();
  }
}

function main() {
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  let problems = 0;

  if (process.argv.includes("--self-test")) {
    problems += selfTest();
    console.log("");
  }

  // The detector has to be trustworthy before its verdicts mean anything, so it
  // proves itself on the known-bad fixture before reading any migration. Without
  // this, a detector that silently stopped detecting would report every file as
  // clean — which is exactly how the previous version of this script passed the
  // migrations that then failed remotely.
  if (chunkFailures(KNOWN_BAD).length === 0) {
    console.error("detector is broken: the known-bad CASE-in-trigger fixture was not rejected");
    process.exit(1);
  }

  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = off");

  for (const name of files) {
    const raw = readFileSync(path.join(dir, name), "utf8");
    const chunks = serverSplit(raw);
    const failures = parseFailures(db, raw);
    console.log(`${failures.length ? "FAIL" : "ok  "} ${name}: ${chunks.length} statement(s)`);
    for (const failure of failures) {
      problems += 1;
      console.log(`     #${failure.index} ${failure.message}`);
      console.log(`        ${failure.head}…`);
    }
  }

  db.close();

  if (problems > 0) {
    console.error(`\n${problems} chunk(s) are cut in half by D1's server-side splitter and cannot be applied remotely.`);
    process.exit(1);
  }

  console.log(`\n${files.length} migration(s) survive D1's server-side statement splitter`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
