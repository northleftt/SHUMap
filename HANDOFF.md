# SHUMap v2 交接文档

> 更新于 2026-08-16。工作区改动已全部提交（批次见下），**但尚未部署**——线上
> Worker 还是 8-14 上传的版本，不含本批后端改动与 crons。部署步骤见「部署」。
> 本地回归全绿：typecheck / 465 测试（28 个文件）/ 19 迁移可应用性 / 切分自测 / build。
> 远端 D1 无待应用迁移（0001–0021 全部就位）。

## 当前状态

- **线上**：https://map.shutf.com ，active release 以公共账号 Worker 为准（2026-08-16 时为 v202608163）。个人号 `shumap.wangyixuan163.workers.dev` 已于 2026-08-15 下线：整站回 410 下线页，`/api/*` 回 JSON 410，不再挂 D1/R2 绑定（旧库 `61c93320-…` 原地封存，未删）。⚠️ 两个账号里 Worker 同名都叫 `shumap`，且根 `wrangler.jsonc` 的 `account_id` 压过 `CLOUDFLARE_ACCOUNT_ID` 环境变量——在根目录 `--name shumap` 操作动的是**正式站**。个人号一律显式 `-c ops/retire-personal-worker/wrangler.jsonc`，详见该目录 README
- **测试**：`npm test` = 465 单测（28 个文件）+ schema 校验 + 迁移可应用性 + 切分检测器自测；`npm run test:all` 额外带 typecheck 与 build
- **提交进度**：批次 1–5 已全部入库（geo 定标重做 → 后端修复五项 → 指南打印 → 小程序收编 → 仓库卫生），main 领先 origin 38 个提交，**尚未 push**

## 2026-08-16 提交批次（自 02e34d6 之后）

1. **地理定标重做**：配准改钉已发布底图（`data/published-maps/`），修掉宝山 ~100m 系统性偏移；管理端「开发工具 → 坐标校准器」；楼栋轮廓自动推导导航终点；图钉大小档位
2. **后端修复五项**：validation_failed release 孤儿行清理、运营事件驳回强制 note、`GET /api/admin/releases` 发布历史 + 点选回滚、隔离区照片 cron 清理（30 天）、`GET /api/public/submissions/:id` 反馈状态查询
3. **指南打印**：guide-print-layout.js、图片全屏查看、可调宽度、按可见内容判空
4. **小程序收编**：`miniprogram/` 并入主仓库（此前是内嵌独立 git 仓库，克隆会缺文件；其原 8 个提交的历史备份在本机 `~/shumap-miniprogram-git-backup`）
5. **仓库卫生**：根目录 358MB 设计素材与品牌文件 gitignore、`remote-png.txt` 删除、`project.private.config.json` 排除

## 部署

```
npm run test:all
npm run deploy:cloudflare
```

- **无待应用迁移**，这次不需要 `db:migrate:remote`。新增的 `triggers.crons`（每天 18:00 UTC 清隔离区照片）随部署生效，部署后可在 Cloudflare 后台确认 cron trigger 挂上
- 部署后建议验证：发布中心出现历史列表（含失败尝试）且回滚按钮可用；`curl https://map.shutf.com/api/public/submissions/submission_xxx` 对随机假 id 回 404；「我的反馈」进页后 pending 状态能回流；次日在 wrangler tail 里看 `quarantine purge:` 日志
- **发版动了 maps（底图换版）时必须重跑配准**：`node scripts/fetch_published_maps.mjs && node scripts/generate_geo_transform.mjs`，然后把三处 geoTransform 同步（`src/lib/release/mapData.ts`、`miniprogram/miniprogram/lib/release/mapData.ts`、`data/geo-transform.json`，`tests/geo-transform-params-in-sync.test.mjs` 会拦不一致）。注意：该测试比对的是**本地钉住的快照**，不是线上——不重跑 fetch 就发版，测试照样绿、参数照样静默漂移（100m 偏移事故的复发路径），所以把重跑写进发版动作里，别依赖测试兜底
- 管理后台凭证向用户索取，不要翻 seed

## 后端行为变化（本批）

- **release 孤儿行**：`validation_failed` / `failed` 的 release 不再留下 `release_items` / `release_map_versions` / `search_documents` 孤儿行；`releases` 行本身保留（validation report 是排障依据），发布历史里能看到这些失败尝试
- **运营事件驳回**：`decideOperationalEvent` reject 时 note 必填（与反馈审核对齐）。注意：管理端还没有运营事件审核 UI，此端点目前只有 API 调用方
- **发布历史**：`GET /api/admin/releases`（read:admin）返回最近 50 条；发布中心从手输版本 ID 改为列表点选 + confirm 回滚
- **隔离区清理**（`worker/modules/maintenance.ts`，每天 cron）：删 `bucket_scope='quarantine' and status='quarantined'` 且超 30 天的 R2 对象；挂在 pending / in_review 反馈上的照片受保护；已决反馈上未采纳的行改 `status='deleted'` 墓碑（`submission_media` 外键是 on delete restrict，不能删行）；未挂任何反馈的孤儿上行连行一起删。单次封顶 300 行
- **反馈状态查询**：`GET /api/public/submissions/:id`，id 即能力凭证（128 位随机串），只回状态与时间戳；web 端「我的反馈」进页时静默刷新未终态记录（`useSubmissionsLog().refreshStatuses`）

## 真实待办（按值得做的顺序）

**1. 部署本批改动**（见上）。8-14 之后的线上是旧的：guide.ts 的 JPEG 放行 / must-revalidate、发布中心韧性读、以及本批全部后端能力都还没上线。

**2. M5 楼层平面图仍无数据（录入工作，不是代码缺口）**
后台 `/admin/floors` 能建楼层、传楼层图、设施编辑器能点选服务位置。剩下的纯粹是录入：建楼层 → 传该层 SVG → 点选。

**3. 提交决定不可复审**
`submission_reviews` 的唯一索引使已决定的提交再次 review 返回 409。误判无法纠正（需要设计，涉及 schema）。

**4. M10 我的：两个入口仍是死的**
`ProfilePage.tsx` 的「关于 SHUMap」「设置」onClick 为空；收藏 / 最近查看仍只是 `navigate("/map")`，无独立列表页（本批已让「我的反馈」状态可回流，其余仍 localStorage）。

**5. 管理端运营事件审核 UI**
后端 decide / note 强制已就绪，但没有页面调用它；运营事件目前只能建不能审。

**6. 云托管代理共享限流桶：代码已修，等配密钥才生效**
原问题：小程序流量经 `miniprogram/cloudrun/shumap-api` 容器代理到 Worker，Cloudflare 看到的 `cf-connecting-ip` 恒为容器出口 IP——`enforcePublicRateLimit` 的所有公共桶（照片上传 30/10min、反馈 20/10min、状态查询 120/10min）在全量小程序用户之间**合计**，少数人用完之后所有人拿 429（Web 端各自独立 IP 不受影响，所以现象是「小程序不能提交反馈」）。

已实现（2026-08-25）：代理把平台注入的 `x-wx-openid` **重新签发**成 `x-shumap-openid`，并附带共享口令 `x-shumap-proxy-secret`；Worker 的 `rateLimitSubject` 仅在口令匹配 `env.MINIPROGRAM_PROXY_SECRET` 时采信该 openid 作限流主体（一人一桶），否则退回按 IP。口令不配 / 不匹配即退回修复前行为，不会因漏配开出旁路。口令比较用逐字节等时比较。

**已上线**（2026-08-25）：Worker secret 已配 + 已部署；云托管环境变量已配，容器已重新部署到
`shumap-api-012`（镜像 tag `…-20260825020631`，流量 100%）。反馈提交的限流粒度现在是一人一桶。

**口令只证明「请求经过了我们的代理」，不证明 `x-wx-openid` 是网关注入的真身份。**
代理分辨不出它是网关给的还是调用方自填的（代理剥的是客户端自带的 `x-shumap-*`，**管不了
`x-wx-openid`**），会照样用真口令签发出去。所以这条链的可信度取决于一个**代码之外**的前提：
容器只能被微信网关调用。

那个前提**实测不成立**。控制台「公网默认域名」显示关闭、API 读到的 `AccessTypes` 为空、
`DefaultDomainName` 为空，但 2026-08-25 03:0x 从**一台与本机无关的第三方主机**
（Anthropic 的 WebFetch 出口，不经本机网络栈）请求容器公网域名
`https://shumap-api-4227820-1465143788.ap-shanghai.run.tcloudbase.com/healthz`，
仍拿到 200 与 `{"ok":true,"upstream":"https://map.shutf.com"}`。
可能是关闭有传播延迟，也可能该开关只收回「默认域名」这个展示入口、
共享 ingress（`tcbr-ingress-a-cxnvet.ap-shanghai.run.tencentcloudbase.com`）仍按 Host 路由。
**结论：别把「控制台显示已关闭」当成安全边界。**

复测方法要选对：本机 curl 一律不可信（见下方排查记录），要么用第三方主机 / 手机流量，
要么用云端出口。这是唯一一次给出确定结论的测法。

因此 `enforcePublicRateLimit` 的纵深防御是这一层真正的依靠，不是可选项：细桶按主体
（可信 openid 则按人，否则按 IP），走 openid 时**额外**过一个按出口 IP 的粗桶，
额度 = 细桶 × `AGGREGATE_MULTIPLIER`(25)（反馈 500/10min、照片上传 750/10min，
远超真实用量但封住了「无限」）。按 IP 计数时不叠粗桶，否则同一请求计两次、额度腰斩。

（排查记录，避免重犯——判断「某个云端地址是否公网可达」时，**这台机器上的 curl 全都不算证据**：
1. 直接 `curl` 域名拿 200 → 不算。`ALL_PROXY` 指向 Clash，DNS 被劫持到 fake-IP `198.18.0.57`，
   200 只说明代理出口节点能到；
2. 加 `--noproxy '*'` + 纯净 DNS 的真实 IP + `--resolve` → 仍不算。`route get 124.223.146.85`
   显示出口接口是 `utun8`，即 TUN 设备按目的地址整段接管，绕过 `*_PROXY` 环境变量没有用；
3. 再加 `--interface en0` 强制走物理网卡 → 还是不算。它对容器域名回 200，但同法打 baidu
   直接超时——负向对照都过不了的测法，正向结果自然无意义。
唯一给出确定结论的是**换一台与本机无关的主机**（这次用 Anthropic 的 WebFetch 出口；
手机蜂窝流量、云端 shell 同理）。教训：测公网可达性前先跑负向对照，
对照不通就说明测法本身坏了，别急着解读正向结果。）

测试：`tests/public-rate-limit-subject.test.mjs`（分桶、伪造退回、粗桶封顶、按 IP 不叠桶）、
`tests/miniprogram-cloudrun-proxy.test.mjs` 第 7~9 条（签发与剥离）。

配置备忘（日后重做或换环境时）：口令不是任何平台发的凭据，自己生成一串随机字符即可
（`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`），
两侧配同值、变量名两侧故意不同：

1. `npx wrangler secret put MINIPROGRAM_PROXY_SECRET`（正式站，注意 account_id 陷阱，见 memory），
   并 `npm run deploy:cloudflare` —— `rateLimitSubject` 的改动要随 Worker 上线；
2. 云托管 `shumap-api` → 服务配置 → 环境变量加 `PROXY_SHARED_SECRET` = 同值
   （CloudBase CLI 的 `cloudrun deploy` 没有设置环境变量的参数，只能在控制台做）；
3. **重新部署容器**（README「重新部署」一节的命令）。注入 `x-shumap-openid` 的代码在
   `server.mjs` 里，只配环境变量的话容器仍跑旧镜像、永远不会带上那两个头，配了等于没配。
   日后只改环境变量不动代码时，保存即滚动重启，无需这步。

控制台「API Key 设置」「时区设置」两个开关都**不用开**：代理零依赖、不用云开发 SDK
（不需要 API Key），也不含任何日期/时区逻辑（不需要时区）。

CloudBase CLI 的登录凭据会过期（`tmp/cloudbase-cli` 里 2026-08-15 那次已失效），
重新登录：`cd tmp/cloudbase-cli && npx cloudbase login --flow device`，浏览器授权后
`npx cloudbase env list` 能列出环境即成功。

**7. 其他**
- 商户视图不显示所在楼层（`floorId` 在 manifest 里有，UI 未用）
- 曲线要素为端点采样近似，可查 `metadata_json.approximated`
- M12 下拉刷新未实装；校外页仍是预留占位
- 小程序 `pages/debug/debug` 保留在 app.json：`miniprogram-release-automator.mjs` 靠它读装配摘要做发版验证，**不是遗留物**，提审前若要移除需同步改 automator

## 地理定标工作流（本批重做，重要）

- **参数绑定发版底图**：`shared/campus-geo-records.mjs` 记录每个校区的 `mapVersionId` + viewBox + 不确定度。同一校区库里存在仓库图 / 发版图两套 `map_features`，坐标空间差 ~107m，拿错整套参数自洽地错（真踩过）
- **控制点采集**：管理端「开发工具 → 坐标校准器」。左嵌腾讯选点器（GCJ-02 真值，`shared/tencent-locpicker.mjs` 管 URL/白名单/回显剔除），右点同一特征的底图位置，成对记录。存 localStorage，定稿导出进 `data/geo-control-points.json`。选点避开「楼中心」（歧义源），用路口 / 场地角 / 校门中线，四角铺开
- **拟合**：`scripts/generate_geo_transform.mjs` 最小二乘 6 参仿射（中心化正规方程），产出 `data/geo-transform.json`；残差米数口径统一走 `geoTransformResiduals`
- **自动导航终点**：`shared/navigation-target.mjs` 轮廓→代表点（质心，L 形 / 环形走扫描线兜底）→逆变换 GCJ-02。`mapVersionId` 不同源直接返回 null 不硬算；管理端选 / 换 / 清 footprint 自动维护该行，人工改过坐标即摘 `derived` 永不覆盖

## 供稿身份：反馈可匿名，采集必须登录（产品决定，改之前先问清楚）

| 链路 | 端点 | 鉴权 | 身份落库 |
|---|---|---|---|
| 用户反馈 | `POST /api/public/submissions` | `optionalSession` | 登录写 `submitter_user_id`，否则 NULL |
| 反馈状态查询 | `GET /api/public/submissions/:id` | 无（id 即凭证） | — |
| 反馈配图 | `POST /api/public/media` | `optionalSession` | 登录写 `uploaded_by`，否则 NULL |
| 志愿者采集 | `/api/public/collection-tasks/*` | `requireSession(…, "collect:data")` | `assignee_user_id` + `submitter_user_id` |

- 匿名时代的反馈行 `submitter_user_id` 保持 NULL：靠 `submitter_name` 自由文本猜账号会把陌生人的提交挂错人（同 0010 的判断）
- `optionalSession` 过期 cookie 视同匿名；采集路由用 `AccountGate permission="collect:data"` 强制登录

## 环境备忘

- **edge 限制**：WebCrypto PBKDF2 ≤ 100k 迭代（`hashPassword` 保持 100_000）
- **D1 远端迁移四条硬限制**（`npm test` 有关卡，见 `scripts/validate_migration_applicability.mjs`）：禁 temp table、单语句 ≤ 10 万字节、compound SELECT ≤ 5 段、触发器体内禁 `CASE`。守卫写成 `select raise(abort,'…') where <cond>;`
- 迁移永远在**远端路径**验证，`--local` 过了不代表远端能过
- 本地：`npx wrangler d1 migrations apply shumap-v2 --local`；`ADMIN_BOOTSTRAP_SECRET` 要用 `--var` 传
- dev server 的 `/api` 代理默认指向 `https://map.shutf.com`（`vite.config.ts`，可用 `VITE_API_PROXY_TARGET` 覆盖）；`scripts/fetch_published_maps.mjs` 同理，本地 worker 用 `--base http://127.0.0.1:8787`
- 根目录的 `返校指南2025秋/`（358MB .ai 源）与 `shumaps.*` 品牌文件已 gitignore，留在磁盘上；指南正稿走 `public/guide` 与 R2，不依赖它们
- Lody 预览白屏是 Lody 自身 CSP `frame-src` 问题，验收用 Chrome 直开
- **校车用时采样手动触发**：`TENCENT_MAP_KEY=... npm run transit:sample`（加 `-- --local` 打本地库）。
  跑的就是 cron 那个 `sampleTravelTimes`，D1 经 `wrangler d1 execute --remote` 打生产库。
  cron 每天北京 02:00 只跑一轮、单轮上限 60 次调用，而排空 188 个区间需 116 次——想立刻看
  效果就手动补一轮。**不要走 `wrangler dev --remote` + scheduled**：生产 secret 不下发到本地
  dev，那条路要求把 key 写进 `.dev.vars`（落盘）。

## 排查经验

- **点击"无反应"先量渲染循环**：`MapPage` 曾因 effect 依赖里的内联新建对象陷入无限重渲染（1.5s 内 70 万次 DOM 变更），饿死路由过渡。用 `MutationObserver` 数变更定位。防线：setter 算出相同值时保持引用不变 + 父组件 memo 化依赖（`CampusMapCanvas.setContainerSize` 即此例）
- **"自检全过"不等于对**：100m 定位偏移事故里所有自检用的是同一份错底图，自洽。跨系统比对（发版 vs 仓库、参数 vs 底图版本）才能抓到，`tests/geo-transform.test.mjs` 第 3 节为此而生——但见上文，它比对的仍是本地快照，重跑 fetch 才是真正的护栏
- **永不静默失败的操作**：腾讯选点器载入回显与真实选点 payload 完全同形，靠与中心常量严格全等区分（`isCenterEcho`）；用容差会误杀中心附近的真实点击
