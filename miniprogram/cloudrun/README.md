# 云托管代理（Part 0：小程序真机/上线前置）

`shumap-api/` 是一个零依赖的 Node 反向代理容器：把微信云托管收到的请求原样转发到
Cloudflare Worker 的**自定义域名** `https://map.shutf.com`。

背景：workers.dev 域名未备案，无法进入小程序合法域名白名单，真机与线上版本的
`wx.request` 直连不可用。小程序改用 `wx.cloud.callContainer` 走云托管出口请求后端，
不受域名白名单限制。小程序端双通道封装见 `miniprogram/miniprogram/lib/api.ts`
（`config.useCloudContainer` 切换）。

**上游必须用自定义域名，不能用 workers.dev**：workers.dev 在中国大陆被网络阻断，
云托管容器（上海）出口实测 ETIMEDOUT（2026-08-07，同容器访问 baidu/cloudflare.com
正常）。自定义域名走 Cloudflare anycast，不受此限。该域名通过 Cloudflare Workers
Custom Domains 挂在 `shumap` Worker 的 production 环境上（shutf.com zone，主机名 `map.shutf.com`）。

## 现状（2026-08-07 已上线）

- 环境：`cloudbase-d1gse9nsp7630b4e7`（个人版，ap-shanghai），服务 `shumap-api`，端口 80。
- 小程序端：`config.ts` 已填 `cloudEnv`，`useCloudContainer: true`（IDE 模拟器验证通过；
  本地要直连调试可临时改回 false）。
- 已验证：release 装配 automator、地图页 automator（SVG 资产走云通道）全部通过。

## 重新部署（CloudBase CLI）

```bash
cd tmp/cloudbase-cli   # @cloudbase/cli 隔离安装目录；未登录先 npx cloudbase login（扫码）
printf '\n\n' | npx cloudbase cloudrun deploy -s shumap-api --port 80 \
  --source "$OLDPWD/miniprogram/cloudrun/shumap-api" --wait --force \
  -e cloudbase-d1gse9nsp7630b4e7
```

`printf` 喂回车是跳过两个交互确认（灰度发布选 No、并发部署确认）；也可用
开发者工具 → 云开发 → 云托管 手动上传 zip。

## 踩过的坑

1. **「云托管资源未开通」**：新建环境后要开通云托管资源（TCC API
   `CreateCloudBaseRunResource`，或控制台点开通），CLI 无对应命令。
2. **首次构建 push 失败**（`invalid checksum digest format`，构建器 attestation 与旧
   TCR 不兼容）：直接重试一次即成功。
3. **content-encoding 必须剥离**：Node fetch 自动解压 gzip/br，若透传上游的
   `content-encoding` 头，微信侧会对已解压的 body 再解压，`callContainer` 报
   `-1000061`。代理已剥除该头并自带单测覆盖。

## 本地自验

```bash
node tests/miniprogram-cloudrun-proxy.test.mjs   # stub 上游单测
PORT=8099 node miniprogram/cloudrun/shumap-api/server.mjs
curl http://localhost:8099/healthz
curl http://localhost:8099/api/public/releases/current
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_BASE` | `https://map.shutf.com` | 上游 Worker（自定义域名） |
| `PORT` | `80` | 监听端口（云托管要求 80） |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 上游超时 |

容器另提供本地探活路径 `/healthz`（不转发）。
