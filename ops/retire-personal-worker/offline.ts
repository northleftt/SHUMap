// 个人号旧站下线页：迁移到公共账号后，这个 Worker 只回 410 并指向正式站。
// 正文里不放任何数据接口，避免旧编辑器入口继续读写个人号那份旧 D1。

const HOME = "https://map.shutf.com";

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>SHUMap 已迁移</title>
<style>
  html,body{margin:0;height:100%}
  body{display:flex;align-items:center;justify-content:center;padding:24px;
    background:#f6f7f9;color:#0f172a;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .card{max-width:420px;background:#fff;border-radius:16px;padding:28px;
    box-shadow:0 10px 30px rgba(15,23,42,.08);text-align:center}
  h1{margin:0 0 10px;font-size:19px;line-height:28px}
  p{margin:0 0 18px;font-size:14px;line-height:22px;color:#475569}
  a{display:inline-block;padding:11px 22px;border-radius:999px;background:#0f172a;
    color:#fff;font-size:14px;font-weight:500;text-decoration:none}
</style>
</head>
<body>
  <div class="card">
    <h1>这个入口已停用</h1>
    <p>SHUMap 已迁到公共账号，地图、返校指南和后台都在新域名下维护。旧个人号的数据不再同步。</p>
    <a href="${HOME}">前往 map.shutf.com</a>
  </div>
</body>
</html>
`;

function gone(): Response {
  return new Response(
    JSON.stringify({
      error: "gone",
      message: "This deployment is retired. Use https://map.shutf.com",
      moved_to: HOME,
    }),
    {
      status: 410,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/**
 * 个人号上已经存在 ReleaseCoordinator 这个 Durable Object 命名空间，新版本脚本
 * 必须继续导出同名类，否则 Cloudflare 拒绝上传（code 10064）。
 *
 * 这里留一个空壳：原实现从不用 state.storage（发布数据全在 D1 与 R2，整个 worker
 * 里搜不到 state.storage），所以 DO 实例本身没有需要保留的持久状态，空壳不会丢数据。
 * 用空壳而不是 delete-class 迁移，是因为删类不可逆；封存期先让它一并回 410。
 */
export class ReleaseCoordinator {
  fetch(): Response {
    return gone();
  }
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);

    // 接口一律回 JSON，别让旧前端拿 HTML 去 JSON.parse。
    if (url.pathname.startsWith("/api/")) return gone();

    return new Response(PAGE, {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },

  /**
   * 这个脚本在个人号上仍注册着 shumap-import 队列的 consumer，所以新版本必须导出
   * queue 处理器，否则上传被拒（code 11001：Queue handler is missing）。
   *
   * 下线后不再有人投递导入任务，这里只把残留消息 ack 掉并留一行日志。
   * 不用 retryAll()：没有处理逻辑，重试只会让消息一直转到超出重试上限，
   * 既不会被处理也更难看出发生过什么。
   */
  queue(batch: { messages: { id: string }[]; ackAll(): void }): void {
    console.log(`retired worker dropped ${batch.messages.length} queue message(s)`);
    batch.ackAll();
  },
};
