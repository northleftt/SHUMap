import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "tmp/miniprogram-test/request-error.cjs");
mkdirSync(dirname(out), { recursive: true });
execFileSync(join(root, "node_modules/.bin/esbuild"), [
  join(root, "miniprogram/miniprogram/lib/request-error.ts"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${out}`,
]);
const { requestErrorType, requestErrorRetryText } = createRequire(import.meta.url)(out);

const cases = [
  [
    "cloud.callContainer:fail Error: errCode: 102002 | errMsg: 请求超时. For more information, please refer to https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/",
    "请求超时",
  ],
  [
    "cloud.callContainer:fail -405010 result expired. timeout for result fetching, result cannot be fetched anymore",
    "结果已过期",
  ],
  ["cloud.callContainer:fail Error: appid missing (callId: 1-0.2)", "身份缺失"],
  ["请求失败（502）", "请求失败"],
  ["网络请求失败", "网络异常"],
  ["something completely unknown", "加载失败"],
];

for (const [raw, type] of cases) {
  assert.equal(requestErrorType(raw), type, raw);
  assert.equal(requestErrorRetryText(new Error(raw)), `${type}，点击重试`);
}

assert.equal(requestErrorRetryText(null), "加载失败，点击重试");

console.log("miniprogram-request-error: all assertions passed");
