// 微信云托管反向代理：把容器收到的请求原样转发到 Cloudflare Worker，
// 解决 workers.dev 未备案、无法进小程序合法域名白名单的问题。
// 小程序侧通过 wx.cloud.callContainer(service: "shumap-api") 访问，
// 云托管出口的请求不受小程序域名白名单限制。
//
// 注意：上游必须用 Worker 的自定义域名（map.shutf.com），
// workers.dev 在中国大陆被网络阻断（容器出口实测 ETIMEDOUT，2026-08-07），
// 自定义域名走 Cloudflare anycast 可正常访问。
//
// 环境变量：
//   UPSTREAM_BASE  上游 Worker 地址（默认 https://map.shutf.com）
//   PORT           监听端口（默认 80，云托管要求容器监听 80）
//
// 无第三方依赖，Node >= 18（用到全局 fetch 与 AbortSignal.timeout）。

import http from "node:http";

const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || "https://map.shutf.com").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 80);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30000);

// 与 Worker 约定的共享口令（Worker 侧同值存为 MINIPROGRAM_PROXY_SECRET）。
// 作用：让 Worker 能确认「这个请求确实是本代理转发的」，从而敢采信随请求带上的
// x-wx-openid 作限流主体（一人一桶）。未配置时不加这个头，Worker 退回按 IP 计数
// ——功能不受影响，只是所有小程序用户重新共享一个限流桶。
const PROXY_SHARED_SECRET = process.env.PROXY_SHARED_SECRET || "";

// 转发时需要剔除的头（hop-by-hop + 平台注入，避免污染上游）。
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  // 客户端自带的这两个头一律丢弃，只认平台注入 / 本代理自己加的值：
  // 否则小程序侧可以自填 openid 轮换限流桶，等于没有限流。
  "x-shumap-proxy-secret",
  "x-shumap-openid",
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  // fetch 已自动解压，body 是解压后的原文；上游的 content-encoding 不能透传，
  // 否则微信侧会对未压缩的 body 再解压导致 callContainer 报错（-1000061）。
  "content-encoding",
]);

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  // 本地探活/手工检查用；Worker 没有此路径，直接本地应答。
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM_BASE }));
    return;
  }

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      headers[key] = value;
    }
  }

  // 身份透传：云托管在用户态调用时注入 x-wx-openid（平台行为，客户端改不了）。
  // 这里把它复制到约定头上，并附带共享口令，Worker 凭口令决定是否采信（限流按人计数）。
  // 没有 openid（未登录态调用等）或没配口令时都不加，Worker 自然退回按 IP。
  const platformOpenId = req.headers["x-wx-openid"];
  if (PROXY_SHARED_SECRET && typeof platformOpenId === "string" && platformOpenId !== "") {
    headers["x-shumap-proxy-secret"] = PROXY_SHARED_SECRET;
    headers["x-shumap-openid"] = platformOpenId;
  }

  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM_BASE}${url}`, {
      method,
      headers,
      body: hasBody ? req : undefined,
      // Node fetch 流式 body 需要显式声明 duplex。
      duplex: hasBody ? "half" : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err && err.cause ? ` cause=${err.cause.code || err.cause.message || err.cause}` : "";
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unreachable", message: `${String(err)}${cause}` }));
    return;
  }

  const responseHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  });
  // 统一用 Buffer 回传，content-length 与实际字节一致（JSON 与 SVG 都安全）。
  // 读 body 也要兜住（解压失败等），避免连接被静默掐断。
  let body;
  try {
    body = Buffer.from(await upstream.arrayBuffer());
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_body_error", message: String(err) }));
    return;
  }
  responseHeaders["content-length"] = String(body.length);

  res.writeHead(upstream.status, responseHeaders);
  res.end(body);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`shumap-api proxy listening on :${PORT}, upstream=${UPSTREAM_BASE}`);
});
