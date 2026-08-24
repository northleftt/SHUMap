#!/usr/bin/env node
// 手动跑一轮校车区间用时采样（worker/modules/travel-time.ts 的 sampleTravelTimes），
// D1 读写经 `wrangler d1 execute --remote` 打到生产库。
//
// 用途：cron 每天只跑一次（wrangler.jsonc triggers.crons，北京 02:00），想立刻
// 看效果时用这个脚本触发一轮，行为与 cron 那一轮完全一致——同一个函数、同一个
// 生产库、同一个 provider。
//
// 为什么不用 `wrangler dev --remote` + scheduled 触发：那条路要求 TENCENT_MAP_KEY
// 在 .dev.vars 里（生产 secret 不下发到本地 dev），而把生产 key 落到磁盘不值得。
// 这里 key 只经环境变量传入，不落盘、不进日志。
//
// 用法：
//   TENCENT_MAP_KEY=... node scripts/run_travel_time_sampling.mjs
//   TENCENT_MAP_KEY=... node scripts/run_travel_time_sampling.mjs --local   # 打本地 D1
//
// D1 适配层的取舍：wrangler CLI 不接受绑定参数，所以这里把值内联进 SQL。内联值
// 全部来自本仓库自己的代码（站点 id、HH:MM、整数秒），不含外部输入；字符串仍按
// SQLite 规则转义单引号，数字校验有限性后才拼接。

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remote = !process.argv.includes("--local");
const DATABASE = "shumap-v2";

const key = process.env.TENCENT_MAP_KEY;
if (!key) {
  console.error("需要 TENCENT_MAP_KEY 环境变量（生产 secret 同名，值不落盘）");
  process.exit(1);
}

/** SQLite 字面量：字符串转义单引号，数字先验有限性，null 原样。 */
function literal(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`非有限数字无法内联：${value}`);
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** 把 `?` 占位符按顺序替换成内联字面量。 */
function inline(sql, values) {
  let index = 0;
  const out = sql.replace(/\?/g, () => {
    if (index >= values.length) throw new Error("占位符多于绑定值");
    return literal(values[index++]);
  });
  if (index !== values.length) throw new Error("绑定值多于占位符");
  return out;
}

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** wrangler 的 --json 输出前面可能夹着 WARNING 行，取第一个 `[` 起的部分。 */
function parseJsonResult(raw) {
  const start = raw.indexOf("[");
  if (start < 0) throw new Error(`wrangler 输出里没有 JSON：${raw.slice(0, 400)}`);
  const parsed = JSON.parse(raw.slice(start));
  return parsed[0]?.results ?? [];
}

let queryCount = 0;

function execSql(sql) {
  queryCount += 1;
  const raw = wrangler([
    "d1", "execute", DATABASE, remote ? "--remote" : "--local",
    "--json", "--command", sql,
  ]);
  return parseJsonResult(raw);
}

function execFile(sql) {
  const dir = mkdtempSync(path.join(tmpdir(), "tts-"));
  const file = path.join(dir, "batch.sql");
  try {
    writeFileSync(file, sql);
    queryCount += 1;
    wrangler(["d1", "execute", DATABASE, remote ? "--remote" : "--local", "--file", file, "--json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class Statement {
  constructor(sql, values = []) {
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.sql, values);
  }

  /** batch 用：这条语句内联后的完整 SQL。 */
  toSql() {
    return inline(this.sql, this.values);
  }

  async first() {
    return execSql(this.toSql())[0] ?? null;
  }

  async all() {
    return { results: execSql(this.toSql()), success: true, meta: {} };
  }

  async run() {
    execSql(this.toSql());
    return { results: [], success: true, meta: {} };
  }
}

const DB = {
  prepare(sql) {
    return new Statement(sql);
  },
  async batch(statements) {
    if (statements.length === 0) return [];
    // 一个事务里一次过：与 D1 的 batch 语义一致（全成或全不成）。
    execFile(`${statements.map((statement) => statement.toSql()).join(";\n")};\n`);
    return statements.map(() => ({ results: [], success: true, meta: {} }));
  },
};

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["worker/modules/travel-time.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const { sampleTravelTimes, MAX_CALLS_PER_RUN } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

console.log(`目标库：${DATABASE}（${remote ? "远端/生产" : "本地"}）`);
console.log(`单轮调用上限：${MAX_CALLS_PER_RUN}\n`);

const before = execSql("select count(*) as n from transit_travel_time_samples")[0]?.n ?? 0;
console.log(`采样前样本数：${before}\n开始采样（每次调用间隔 1.5s，请等待）…\n`);

const started = Date.now();
const summary = await sampleTravelTimes({ DB, TENCENT_MAP_KEY: key });
const seconds = ((Date.now() - started) / 1000).toFixed(0);

const after = execSql("select count(*) as n from transit_travel_time_samples")[0]?.n ?? 0;
console.log(`\n=== 本轮结果（${seconds}s，${queryCount} 次 D1 往返）===`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\n样本数：${before} → ${after}（新增 ${after - before}）`);
