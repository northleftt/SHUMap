// staging 灌数据工具：把 wrangler d1 export 的生产 dump 重写成 D1 可导入的单文件。
// 用法：node scripts/prepare_staging_dump.mjs [输入.sql] [输出.sql]
//
// 踩过的三个坑（2026-09-17，wrangler 4.95 + D1 远程导入口实测）：
// 1. 单条语句长度上限（SQLITE_TOOBIG，实测 200KB 也会触发）：guide_revisions 的
//    巨型 content_json 原地改写为「先向 _staging_big_payload 分块拼接（每块 45KB）
//    → 原 INSERT 用标量子查询回填」，文末 DROP 该辅助表。
// 2. 导入口按语句即时强制 FK（dump 首行的 defer_foreign_keys 不起作用），
//    而 dump 按 sqlite_master 创建顺序排列，子表 INSERT 先于父表出现。
//    对策：文件头加 PRAGMA foreign_keys=OFF（会话级，导完自动恢复）；
//    数据来自生产快照，FK 一致性由源库保证。
// 3. 保险起见再把所有 CREATE TABLE 提升到 PRAGMA 之后、INSERT 之前
//    （CREATE TABLE 之间的 FK 引用允许悬挂，先建全表再插数据最稳）。
import { readFileSync, writeFileSync } from "node:fs";

const SRC = process.argv[2] || "tmp/staging/prod-dump.sql";
const OUT = process.argv[3] || "tmp/staging/prod-dump-fixed.sql";
const BIG_LINE = 60_000;
const PIECE_SIZE = 45_000;

const lines = readFileSync(SRC, "utf8").split("\n").filter((l) => l.length > 0);

// 在字符串字面量内部找安全的切分点：不能把 '' 转义对劈开。
function safeSplitPoints(text, size) {
  const points = [];
  let i = 0;
  while (i + size < text.length) {
    let p = i + size;
    let k = 0;
    while (text[p - 1 - k] === "'") k++;
    if (k % 2 === 1) p -= 1;
    points.push(p);
    i = p;
  }
  return points;
}

// 拆分 VALUES(...) 顶层逗号（尊重引号）
function splitValues(inner) {
  const parts = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          cur += inner[i + 1];
          i++;
        } else {
          inStr = false;
        }
      }
    } else if (ch === "'") {
      inStr = true;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

const out = [];
let bigRowCount = 0;
let payloadTableDeclared = false;

// 第一遍：把多行 CREATE TABLE 整体提升到文件最前（PRAGMA 之后）。
// dump 按 sqlite_master 创建顺序排列，子表（如 entity_locations）排在父表
// （location_anchors）之前；即使 FK 关闭，先把 schema 建全也是最稳的顺序
// （CREATE TABLE 之间的 FK 引用允许悬挂）。
const createTables = [];
const restLines = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^CREATE TABLE /.test(line)) {
    let stmt = line;
    while (!stmt.trimEnd().endsWith(";")) {
      i++;
      stmt += "\n" + lines[i];
    }
    createTables.push(stmt);
  } else {
    restLines.push(line);
  }
}

for (const line of restLines) {
  if (line.length <= BIG_LINE) {
    out.push(line);
    continue;
  }
  const m = line.match(/^(INSERT INTO "[^"]+" \([^)]*\) VALUES\()(.*\);\s*)$/);
  if (!m) throw new Error(`无法解析的大行: ${line.slice(0, 80)}`);
  const [, prefix, rest] = m;
  const inner = rest.slice(0, rest.lastIndexOf(")"));
  const fields = splitValues(inner);
  if (!payloadTableDeclared) {
    out.push("CREATE TABLE IF NOT EXISTS _staging_big_payload (k TEXT PRIMARY KEY, val TEXT NOT NULL);");
    payloadTableDeclared = true;
  }
  const rowId = `r${bigRowCount++}`;
  const outFields = fields.map((f, idx) => {
    if (f.length <= BIG_LINE) return f;
    if (!f.startsWith("'") || !f.endsWith("'")) throw new Error("大字段不是字符串字面量");
    const key = `${rowId}_c${idx}`;
    const body = f.slice(1, -1);
    out.push(`INSERT INTO _staging_big_payload (k, val) VALUES ('${key}', '');`);
    const points = safeSplitPoints(body, PIECE_SIZE);
    let start = 0;
    for (const p of [...points, body.length]) {
      const piece = body.slice(start, p);
      start = p;
      if (piece.length === 0) continue;
      out.push(`UPDATE _staging_big_payload SET val = val || '${piece}' WHERE k = '${key}';`);
    }
    return `(SELECT val FROM _staging_big_payload WHERE k = '${key}')`;
  });
  out.push(`${prefix}${outFields.join(",")});`);
}
if (payloadTableDeclared) out.push("DROP TABLE IF EXISTS _staging_big_payload;");
const pragma = out.length > 0 && out[0].startsWith("PRAGMA") ? out.shift() : null;
// D1 导入口按语句即时强制 FK（defer_foreign_keys 不起作用），导入期间整段关掉；
// 数据来自生产库快照，FK 一致性已由源库保证。会话结束自动恢复。
const finalLines = ["PRAGMA foreign_keys=OFF;", ...(pragma ? [pragma] : []), ...createTables, ...out];
writeFileSync(OUT, finalLines.join("\n") + "\n");
console.log(
  JSON.stringify({ out: OUT, bigRows: bigRowCount, statements: finalLines.length, createTables: createTables.length }, null, 2),
);
