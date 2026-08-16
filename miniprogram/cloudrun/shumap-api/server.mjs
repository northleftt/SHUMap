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

// 转发时需要剔除的头（hop-by-hop + 平台注入，避免污染上游）。
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
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
