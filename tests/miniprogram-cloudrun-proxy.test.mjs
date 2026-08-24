// 云托管代理（cloudrun/shumap-api/server.mjs）纯逻辑自验，直接在 node 里跑：
// 起本地 stub 上游 + 代理进程，断言转发语义，不碰真实 Worker、不经微信开发者工具。
// 1. /healthz 本地应答不转发；
// 2. GET path+query 原样转发，JSON content-type 透传；
// 3. 非 JSON（SVG）content-type 与字节透传；
// 4. 上游非 2xx 状态码透传；
// 5. POST body 流式转发；
// 6. 限流身份头：平台注入的 openid 被重新签发成 x-shumap-openid + 共享口令，
//    客户端自带的这两个头一律先剥掉（否则可自填 openid 轮换限流桶）。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROXY_PORT = 18091;
const UPSTREAM_PORT = 18092;
/** 代理与 Worker 的共享口令；测试里随便取值，只要两侧一致。 */
const PROXY_SECRET = "test-proxy-secret-0123456789";

const seen = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
req.on("end", () => {
    const requestBody = Buffer.concat(chunks);
    seen.push({
      method: req.method,
      url: req.url,
      body: requestBody.toString(),
      bytes: requestBody,
      contentType: req.headers["content-type"] ?? "",
      headers: req.headers,
    });
    if (req.url.startsWith("/json")) {
      // 故意真实 gzip：模拟上游压缩响应。fetch 自动解压后，代理必须剥掉 content-encoding。
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify({ ok: true })));
    } else if (req.url.startsWith("/svg")) {
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
      res.end("<svg>stüb</svg>");
    } else if (req.url.startsWith("/echo")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(requestBody);
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    }
  });
});

await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

const proxy = spawn("node", [join(repoRoot, "miniprogram/cloudrun/shumap-api/server.mjs")], {
  env: {
    ...process.env,
    PORT: String(PROXY_PORT),
    UPSTREAM_BASE: `http://127.0.0.1:${UPSTREAM_PORT}`,
    PROXY_SHARED_SECRET: PROXY_SECRET,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  proxy.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  proxy.on("exit", () => reject(new Error("proxy exited early")));
  setTimeout(() => reject(new Error("proxy start timeout")), 10000);
});

try {
  // 1. healthz 本地应答
  const health = await fetch(`http://127.0.0.1:${PROXY_PORT}/healthz`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(seen.length, 0, "healthz 不应转发到上游");

  // 2. GET path+query 原样转发
  const jsonRes = await fetch(`http://127.0.0.1:${PROXY_PORT}/json/a?x=1&y=%E5%9B%BE`);
  assert.equal(jsonRes.status, 200);
  assert.match(jsonRes.headers.get("content-type"), /application\/json/);
  assert.equal(jsonRes.headers.get("content-encoding"), null, "content-encoding 必须剥离");
  assert.deepEqual(await jsonRes.json(), { ok: true });
  assert.equal(seen.at(-1).url, "/json/a?x=1&y=%E5%9B%BE");

  // 3. SVG content-type 与字节透传
  const svgRes = await fetch(`http://127.0.0.1:${PROXY_PORT}/svg`);
  assert.match(svgRes.headers.get("content-type"), /image\/svg\+xml/);
  assert.equal(await svgRes.text(), "<svg>stüb</svg>");

  // 4. 上游 404 透传
  const nf = await fetch(`http://127.0.0.1:${PROXY_PORT}/nope`);
  assert.equal(nf.status, 404);

  // 5. POST body 流式转发
  const post = await fetch(`http://127.0.0.1:${PROXY_PORT}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "世界" }),
  });
  assert.equal(post.status, 200);
  assert.equal(await post.text(), JSON.stringify({ hello: "世界" }));
  assert.equal(seen.at(-1).method, "POST");

  // 6. 投稿照片所需的原始二进制与 content-type 均原样透传
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);
  const binaryPost = await fetch(`http://127.0.0.1:${PROXY_PORT}/echo`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: imageBytes,
  });
  assert.deepEqual(Buffer.from(await binaryPost.arrayBuffer()), imageBytes);
  assert.deepEqual(seen.at(-1).bytes, imageBytes);
  assert.equal(seen.at(-1).contentType, "image/png");

  // 7. 平台注入的 openid → 重新签发为 x-shumap-openid + 共享口令
  await fetch(`http://127.0.0.1:${PROXY_PORT}/json`, {
    headers: { "x-wx-openid": "oABC123" },
  });
  assert.equal(seen.at(-1).headers["x-shumap-openid"], "oABC123", "openid 应转成约定头交给 Worker");
  assert.equal(seen.at(-1).headers["x-shumap-proxy-secret"], PROXY_SECRET, "并附带共享口令供 Worker 校验");

  // 8. 客户端自带的身份头一律剥掉：否则小程序侧可自填 openid 轮换限流桶。
  //    这一条是整个方案的安全前提，回归掉了等于限流形同虚设。
  await fetch(`http://127.0.0.1:${PROXY_PORT}/json`, {
    headers: {
      "x-shumap-openid": "oFORGED",
      "x-shumap-proxy-secret": "guessed-secret",
    },
  });
  assert.equal(
    seen.at(-1).headers["x-shumap-openid"],
    undefined,
    "客户端自带的 x-shumap-openid 必须被剥掉",
  );
  assert.equal(
    seen.at(-1).headers["x-shumap-proxy-secret"],
    undefined,
    "客户端自带的口令头必须被剥掉",
  );

  // 9. 没有平台 openid（未登录态调用）时不加身份头，Worker 自然退回按 IP 计数。
  await fetch(`http://127.0.0.1:${PROXY_PORT}/json`);
  assert.equal(seen.at(-1).headers["x-shumap-openid"], undefined);
  assert.equal(seen.at(-1).headers["x-shumap-proxy-secret"], undefined);

  console.log("[ok] 云托管代理转发语义全部通过（healthz/query/SVG/404/POST body/限流身份头签发与剥离）");
} finally {
  proxy.kill();
  upstream.close();
}
