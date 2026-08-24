// 公共限流的「主体」判定回归。
//
// 背景（用户报「小程序反馈提交不了」的根因）：小程序流量全部经微信云托管代理
// （miniprogram/cloudrun/shumap-api）转发到 Worker，Cloudflare 看到的
// cf-connecting-ip 恒为容器出口那一个 IP。按 IP 计数时，submission-create 的
// 20 次/10 分钟在**全体小程序用户之间合计**，用光之后所有人提交都拿 429；
// Web 端各自独立 IP 不受影响，所以症状表现为「只有小程序不能提交」。
//
// 修法：代理把平台注入的 x-wx-openid 连同共享口令重新签发成
// x-shumap-openid / x-shumap-proxy-secret，Worker 凭口令决定是否采信，采信则一人一桶。
// 这里断言六件事：
//   1. 无代理头（Web 直连）→ 按 IP，且不同 IP 分桶；
//   2. 带正确口令 → 按 openid，同一出口 IP 的不同用户互不影响（核心回归）；
//   3. 口令缺失 / 错误 / 未配置 → 退回按 IP，不给可伪造的旁路；
//   4. 代理会剥掉客户端自带的这两个头（server.mjs 的 STRIP_REQUEST_HEADERS）；
//   5. 走 openid 细桶时额外记一个按出口 IP 的粗桶（额度 ×AGGREGATE_MULTIPLIER）：
//      容器开着公网访问，openid 的真实性不由我们掌握，粗桶把「伪造并轮换 openid」
//      的收益限制成有限倍数而不是无限；
//   6. 按 IP 计数时不加粗桶（细桶已是 IP 粒度，否则同一请求被重复计两次）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/rate-limit-test");
mkdirSync(outDir, { recursive: true });

const bundle = join(outDir, "rate-limit.cjs");
execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "worker/lib/public-rate-limit.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${bundle}`,
]);

const require = createRequire(import.meta.url);
const { enforcePublicRateLimit } = require(bundle);

/** 记录每次 upsert 用到的 key，据此判断「谁和谁共用一个桶」。 */
function stubEnv(extra = {}) {
  const keys = [];
  const counts = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("insert into public_rate_limits")) {
            const key = values[0];
            keys.push(key);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          } else {
            this.selectKey = values[0];
          }
          return this;
        },
        run: async () => ({ results: [], success: true, meta: {} }),
        first: async () => ({ requestCount: counts.get(this?.selectKey) ?? 0 }),
      };
    },
  };
  // select 分支要拿到刚 bind 的 key，单独实现一份带状态的 prepare。
  db.prepare = (sql) => {
    let bound = null;
    return {
      bind(...values) {
        bound = values;
        if (sql.includes("insert into public_rate_limits")) {
          keys.push(values[0]);
          counts.set(values[0], (counts.get(values[0]) ?? 0) + 1);
        }
        return this;
      },
      run: async () => ({ results: [], success: true, meta: {} }),
      first: async () => ({ requestCount: counts.get(bound?.[0]) ?? 0 }),
    };
  };
  return { env: { DB: db, ...extra }, keys, counts };
}

function request(headers) {
  return new Request("https://map.shutf.com/api/public/submissions", { method: "POST", headers });
}

const SECRET = "proxy-shared-secret-value";
const CONTAINER_IP = "203.0.113.7";

// ---------------------------------------------------------------------------
// 1. 无代理头：按 IP，不同 IP 不同桶
// ---------------------------------------------------------------------------
{
  const { env, keys } = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  await enforcePublicRateLimit(request({ "cf-connecting-ip": "1.1.1.1" }), env, "submission-create", 20);
  await enforcePublicRateLimit(request({ "cf-connecting-ip": "2.2.2.2" }), env, "submission-create", 20);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "不同 IP 必须落在不同的桶");
}

// ---------------------------------------------------------------------------
// 2. 带正确口令：按 openid 分桶——同一容器出口 IP 的两个用户互不挤占（核心回归）
// ---------------------------------------------------------------------------
{
  const { env, keys } = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  const headers = (openId) => ({
    "cf-connecting-ip": CONTAINER_IP,
    "x-shumap-proxy-secret": SECRET,
    "x-shumap-openid": openId,
  });
  // 走 openid 时每次请求记两个桶：细桶（openid）+ 粗桶（出口 IP），见第 5 节。
  // 所以细桶落在偶数下标：keys[0]=A、keys[2]=B、keys[4]=A。
  await enforcePublicRateLimit(request(headers("openid-A")), env, "submission-create", 20);
  await enforcePublicRateLimit(request(headers("openid-B")), env, "submission-create", 20);
  await enforcePublicRateLimit(request(headers("openid-A")), env, "submission-create", 20);
  assert.notEqual(keys[0], keys[2], "同一出口 IP 的不同 openid 必须分桶");
  assert.equal(keys[0], keys[4], "同一 openid 必须落回同一个桶");
}

// ---------------------------------------------------------------------------
// 3. 口令缺失 / 错误 / 服务端未配置：一律退回按 IP，openid 不被采信
// ---------------------------------------------------------------------------
{
  // 基准：纯 IP 请求的桶 key
  const baseline = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  await enforcePublicRateLimit(request({ "cf-connecting-ip": CONTAINER_IP }), baseline.env, "s", 20);
  const ipKey = baseline.keys[0];

  // 3a. 只带 openid、不带口令（直连 Worker 伪造）→ 仍按 IP
  const noSecret = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  await enforcePublicRateLimit(
    request({ "cf-connecting-ip": CONTAINER_IP, "x-shumap-openid": "forged" }),
    noSecret.env,
    "s",
    20,
  );
  assert.equal(noSecret.keys[0], ipKey, "没有口令时 openid 不得被采信");

  // 3b. 口令错误 → 仍按 IP
  const wrongSecret = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  await enforcePublicRateLimit(
    request({
      "cf-connecting-ip": CONTAINER_IP,
      "x-shumap-proxy-secret": "wrong",
      "x-shumap-openid": "forged",
    }),
    wrongSecret.env,
    "s",
    20,
  );
  assert.equal(wrongSecret.keys[0], ipKey, "口令不匹配时必须退回按 IP");

  // 3c. 服务端没配口令（漏配）→ 即便请求带着口令也不采信
  const unset = stubEnv({});
  await enforcePublicRateLimit(
    request({
      "cf-connecting-ip": CONTAINER_IP,
      "x-shumap-proxy-secret": SECRET,
      "x-shumap-openid": "forged",
    }),
    unset.env,
    "s",
    20,
  );
  assert.equal(unset.keys[0], ipKey, "未配置口令时不得开出可伪造的旁路");
}

// ---------------------------------------------------------------------------
// 4. 超限抛 429（限流本身没被改坏）
// ---------------------------------------------------------------------------
{
  const { env } = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  const headers = { "cf-connecting-ip": "9.9.9.9" };
  await enforcePublicRateLimit(request(headers), env, "tiny", 2);
  await enforcePublicRateLimit(request(headers), env, "tiny", 2);
  await assert.rejects(
    () => enforcePublicRateLimit(request(headers), env, "tiny", 2),
    (error) => error.status === 429 && error.code === "rate_limited",
    "超过额度必须 429 rate_limited",
  );
}

// ---------------------------------------------------------------------------
// 5. 按 IP 计数时只有一个桶（粗桶不叠加，否则同一请求被计两次、额度腰斩）
// ---------------------------------------------------------------------------
{
  const { env, keys } = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  await enforcePublicRateLimit(request({ "cf-connecting-ip": "1.1.1.1" }), env, "s", 20);
  assert.equal(keys.length, 1, "按 IP 计数的请求只应记一个桶");
}

// ---------------------------------------------------------------------------
// 6. openid 细桶 + 出口 IP 粗桶：轮换 openid 的收益被限制成有限倍数
//
// 容器的 AccessTypes 含 PUBLIC，任何人都能直连容器公网域名并自带 x-wx-openid；
// 代理剥掉的是客户端自带的 x-shumap-*，管不了 x-wx-openid，于是会用真口令把它
// 签发出去。所以「口令匹配」只证明经过了代理，不证明 openid 是平台注入的真身份。
// 粗桶是这一层的兜底。
// ---------------------------------------------------------------------------
{
  const { env, keys } = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  const headers = (openId) => ({
    "cf-connecting-ip": CONTAINER_IP,
    "x-shumap-proxy-secret": SECRET,
    "x-shumap-openid": openId,
  });

  await enforcePublicRateLimit(request(headers("openid-A")), env, "s", 20);
  assert.equal(keys.length, 2, "走 openid 时应记两个桶：openid 细桶 + 出口 IP 粗桶");
  assert.notEqual(keys[0], keys[1]);

  // 不同 openid 的细桶不同，但粗桶必须是同一个（同一出口 IP）
  await enforcePublicRateLimit(request(headers("openid-B")), env, "s", 20);
  assert.notEqual(keys[2], keys[0], "不同 openid 的细桶必须不同");
  assert.equal(keys[3], keys[1], "同一出口 IP 的粗桶必须是同一个");

  // 每次换一个新 openid（细桶永远是 1），粗桶仍会累积到 limit×倍数 后 429
  const limit = 2;
  const multiplier = 25;
  const fresh = stubEnv({ MINIPROGRAM_PROXY_SECRET: SECRET });
  let rejected = false;
  for (let index = 0; index < limit * multiplier + 1; index += 1) {
    try {
      await enforcePublicRateLimit(request(headers(`rotating-${index}`)), fresh.env, "s", limit);
    } catch (error) {
      assert.equal(error.status, 429);
      assert.equal(error.code, "rate_limited");
      rejected = true;
      break;
    }
  }
  assert.ok(rejected, "无限轮换 openid 也必须最终被出口 IP 粗桶挡住");
}

// ---------------------------------------------------------------------------
// 7. 代理侧：客户端自带的身份头必须被剥掉，且 openid 由平台头重新签发
// ---------------------------------------------------------------------------
{
  const proxySource = readFileSync(
    join(repoRoot, "miniprogram/cloudrun/shumap-api/server.mjs"),
    "utf8",
  );
  assert.match(
    proxySource,
    /STRIP_REQUEST_HEADERS[\s\S]*"x-shumap-proxy-secret"/,
    "代理必须剥掉客户端自带的 x-shumap-proxy-secret",
  );
  assert.match(
    proxySource,
    /STRIP_REQUEST_HEADERS[\s\S]*"x-shumap-openid"/,
    "代理必须剥掉客户端自带的 x-shumap-openid",
  );
  assert.match(
    proxySource,
    /headers\["x-shumap-openid"\]\s*=\s*platformOpenId/,
    "代理必须用平台注入的 x-wx-openid 重新签发身份头",
  );
  // Worker 读的两个头名必须与代理注入的一致（这一对写错过一次：worker 读 x-wx-openid、
  // 代理发 x-shumap-openid，结果限流又整体退回按 IP，故障静默复现）。
  const workerSource = readFileSync(join(repoRoot, "worker/lib/public-rate-limit.ts"), "utf8");
  assert.match(workerSource, /request\.headers\.get\("x-shumap-proxy-secret"\)/);
  assert.match(workerSource, /request\.headers\.get\("x-shumap-openid"\)/);
}

console.log("[ok] 公共限流主体：Web 按 IP、小程序凭代理口令按 openid 分桶，伪造头一律退回按 IP");
