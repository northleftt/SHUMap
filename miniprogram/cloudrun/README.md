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
| `PROXY_SHARED_SECRET` | 空 | 与 Worker 的共享口令，用于限流按人分桶（见下） |

容器另提供本地探活路径 `/healthz`（不转发）。

## `PROXY_SHARED_SECRET`：让限流按人计数而不是按容器 IP

小程序全部流量经本容器转发，Worker 看到的 `cf-connecting-ip` 恒为容器出口那一个 IP，
于是 `enforcePublicRateLimit` 的公共桶（反馈 20/10min、照片上传 30/10min、状态查询
120/10min）在**全体小程序用户之间合计**——少数人用完，之后所有人提交都拿 429
（Web 端各自独立 IP，不受影响，所以现象是「只有小程序不能提交反馈」）。

机制：云托管在用户态调用时注入 `x-wx-openid`（平台行为，客户端改不了）。本代理把它
**重新签发**成 `x-shumap-openid`，并附带 `x-shumap-proxy-secret: $PROXY_SHARED_SECRET`；
Worker 的 `rateLimitSubject`（`worker/lib/public-rate-limit.ts`）只在该口令匹配自己的
`MINIPROGRAM_PROXY_SECRET` 时才采信这个 openid 作限流主体，否则退回按 IP。

三个安全点，改这块时别退化：

- 代理**先无条件剥掉**客户端自带的 `x-shumap-openid` / `x-shumap-proxy-secret`
  （`STRIP_REQUEST_HEADERS`），否则任何人都能自填 openid 轮换限流桶；
- Worker 有公网自定义域名，直连者可伪造这两个头，所以口令校验是必需的，
  且用逐字节等时比较。口令未配 / 不匹配 → 退回按 IP，即修复前的行为，
  **不会**因为漏配而开出一个可伪造的旁路；
- **口令只证明「请求经过了本代理」，不证明「openid 是网关注入的真身份」**，
  代理剥的是客户端自带的 `x-shumap-*`，**管不了 `x-wx-openid`**，自填的一样会被签发出去。
  这条链之所以可信，靠的是一个**代码之外的前提**：本服务已关闭公网默认域名
  （2026-08-25 确认：`AccessTypes` 为空、`DefaultDomainName` 为空），只能被微信网关经
  小程序 / OA 通道调用，于是 openid 必然由网关注入。
  **别为了排查方便打开公网访问**——一开就退化成「自填 openid 即可无限轮换限流桶」。
  作为纵深防御，Worker 侧另有一层**按出口 IP 的粗桶**（`AGGREGATE_MULTIPLIER = 25`，
  即反馈 500 次/10min、照片上传 750 次/10min），即便前提被破坏也只是有限放大。

口令本身没有「在哪里取」——它是你自己生成的一串随机字符，两侧配成同一个值即可：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

配置三步（缺任一步都只是退回按 IP，功能正常）：

```bash
# 1. Worker 侧（正式站；account_id 陷阱见 memory wrangler-account-id-overrides-env）
npx wrangler secret put MINIPROGRAM_PROXY_SECRET   # 粘贴上面生成的值 —— 2026-08-25 已配
npm run deploy:cloudflare                          # rateLimitSubject 的改动要随 Worker 上线

# 2. 容器侧环境变量：控制台 → 云开发 → 云托管 → shumap-api → 服务配置 → 环境变量
#    加 PROXY_SHARED_SECRET = <同一个值>。CloudBase CLI 的 cloudrun deploy 没有设置
#    环境变量的参数，这一步只能在控制台做。 —— 2026-08-25 已配

# 3. 重新部署容器 —— 别跳过这步。      —— 2026-08-25 已部署（版本 shumap-api-012）
#    注入 x-shumap-openid 的代码在 server.mjs 里，线上镜像是加这段之前构建的，
#    只配环境变量的话容器仍跑旧代码、永远不会带上那两个头，配了也等于没配。
cd tmp/cloudbase-cli
printf '\n\n' | npx cloudbase cloudrun deploy -s shumap-api --port 80 \
  --source "$OLDPWD/miniprogram/cloudrun/shumap-api" --wait --force \
  -e cloudbase-d1gse9nsp7630b4e7
```

**状态（2026-08-25）**：第 1 步的 `secret put` 与第 2、3 步已完成，容器在跑
`shumap-api-012`。**尚未做**第 1 步的 `deploy:cloudflare` —— 线上 Worker 仍是旧代码
（`wrangler deployments list` 最新一条 source 是 Secret Change，不含代码更新），
所以 `rateLimitSubject` 与粗桶都还没生效，当前线上仍是「全体小程序用户一个桶」。

（日后只改环境变量、不动 `server.mjs` 时，保存即滚动重启，无需第 3 步。）

验证（正式站，不写库）：连打 21 次反馈提交端点，用故意非法的 payload 让它停在校验阶段，
观察第 21 次返回的是校验错误还是 `rate_limited` —— 配好之后按 openid 分桶，
从 Web 端直连不会再被小程序流量挤掉。单测覆盖：
`tests/public-rate-limit-subject.test.mjs`、`tests/miniprogram-cloudrun-proxy.test.mjs`。
