# SHUMap v2 交接文档

> 更新于 2026-08-03。**工作区有未部署的改动**：供稿身份 + 楼层图管理（见下方同名小节）。
> 本地回归全绿：typecheck / 151 测试 / 16 迁移可应用性 / 切分自测 / build。
> **远端 D1 有一条待应用迁移（`0018`）**，部署前必须先跑 `npm run db:migrate:remote`。
>
> 本文档每条待办都在 2026-08-03 逐条对代码核过。改动代码后请同步这里，不要让它再次腐烂。

## 当前状态

- **线上**：https://shumap.wangyixuan163.workers.dev ，active release `v2026-07-18-initial`（121 places、8 条线路、3 个校区级地图版本）
- **迁移**：`0001`–`0016` + `0018`（`0007` / `0017` 从未存在，不是丢了；`0017` 是并行开发时为避免撞号预留的空号）。**`0018` 尚未应用到远端**，部署前必须先跑 `npm run db:migrate:remote`
- **测试**：`npm test` = 151 单测（20 个文件）+ schema 校验 + 迁移可应用性 + 切分检测器自测；`npm run test:all` 额外带 typecheck 与 build
- **提交进度**：`1f35c46`（W-A~W-E 合并）之后有批次 1–8 共 8 个提交，最新 `e990483`

## 已解决（此前 backlog 里记为待办，现已落地）

核对代码后确认这些条目不再成立，勿再照旧文档排期：

- **A11 设施锚点可编辑**：`FacilityEditorPage.tsx` 已能编辑 `service_position` 锚点（`:173` 读现有锚点、`:456` 以该 role 写回）。M5 徽章的数据入口已通
- **`shape_hash` 已写入**：`worker/modules/jobs.ts:126` 对序列化几何取 sha256 并随 `map_features` 落库
- **`/api/analytics/events` 已在 v2 契约内**：`worker/index-v2.ts:70` 有路由，线上探测返回 400（校验）而非 404。不再是静默 no-op
- **M2 照片轮播**：`PhotoCarousel` 已在 `PoiDetailSheet.tsx` 实装
- **M6 进展时间线**：`OperationDetailSheet.tsx:197-201` 已渲染 `updates`
- **桌面端商户面板**：`DesktopMapPanel.tsx:135-148` 已有楼内商户入口

## 真实待办（按值得做的顺序）

**1. M5 楼层平面图仍无数据（录入工作，不是代码缺口）**
线上 manifest 里 `maps` 3 条全是校区级（`floor_id: null`），楼层级图纸 0 条；`floors` 仅 1 条（A 楼 1 层）、`facilities` 0 条、`service_position` 锚点 0 条。因此所有楼宇都不出现 `平面图` 切换入口。

**代码侧已补齐**（见下方「楼层与楼层图管理」）：后台 `/admin/floors` 现在能建楼层、传楼层图、看该层挂了哪些设施 / 商户。剩下的纯粹是录入：建楼层 → 传该层 SVG → 在设施编辑器里点选服务位置。

**2. 校验失败的 release 留下孤儿行**
`buildCandidate`（`worker/modules/releases.ts:487-607`）在 `:596-605` 就把 `release_items` / `release_map_versions` / `search_documents` 批量写库，而 `validateCandidate` 要到 `:408` 才跑。`validation_failed` 的 release 会把这些行留在库里，无清理。

**3. 运营事件驳回不强制 note**
`decideOperationalEvent`（`worker/modules/operations.ts`）的 `note` 走 `optionalString`，reject 时不校验非空。对比 `submissions.ts:200` 已强制（`decision === "reject" && note === null` 直接报错），两边应对齐。

**4. A5 发布中心没有历史列表**
后端只有 `POST /api/admin/releases` 与 `POST /api/admin/releases/:id/rollback`，无历史查询端点。`ReleasesPage` 的“历史版本”面板只显示当前线上那一条，回滚要手输版本号（`:260`）。回滚会立刻影响全体用户，手输 ID 风险偏高。

**5. 隔离区照片无清理**
`wrangler.jsonc` 无 crons、worker 无 `scheduled` handler，`quarantine/submissions/` 下未采纳的照片会长期堆积。防滥用目前仅靠 IP 限速（30 次 / 10 分钟）。照片采纳为全有全无，无法逐张选择。

**6. 提交决定不可复审**
`submission_reviews` 的唯一索引使已决定的提交再次 review 返回 409 `invalid_state`（`submissions.ts:252`）。误判无法纠正。

**7. 反馈状态无公共查询端点**
公共侧只有 `POST /api/public/submissions`，没有 GET。用户提交后查不到处理状态；前端“我的反馈”靠 localStorage 记录，换设备即丢。

**8. M10 我的：两个入口是死的**
`ProfilePage.tsx:103` / `:108`（关于 SHUMap、设置）的 `onClick` 是空函数。“我的收藏”“最近查看”也只是 `navigate("/map")`，没有独立列表页。收藏 / 最近查看 / 我的反馈全部 = localStorage。

**9. 其他**
- 商户视图不显示所在楼层（`floorId` 在 manifest 里有，UI 未用；档口号已显示）
- 曲线要素为端点采样近似，可查 `metadata_json.approximated`
- M12 下拉刷新未实装
- 商户链路未用真实发布数据做过端到端验证

## 供稿身份：反馈可匿名，采集必须登录

这是产品决定，不是实现细节，改之前先问清楚：

| 链路 | 端点 | 鉴权 | 身份落库 |
|---|---|---|---|
| 用户反馈 | `POST /api/public/submissions` | `optionalSession` —— 不登录也能提 | 登录则写 `submitter_user_id`，否则为 NULL |
| 反馈配图 | `POST /api/public/media` | `optionalSession` | 登录则写 `uploaded_by`，否则为 NULL |
| 志愿者采集 | `/api/public/collection-tasks/*` 四个 | `requireSession(…, "collect:data")` | `assignee_user_id`，且提交时带进 `submitter_user_id` |

理由：路过的人发现信息有误就该能直接说，不必先注册；而采集是有组织的数据录入，必须能追责。

- `submitter_user_id`（0018 新增）由服务端从会话取，请求体改不动。`submitterName` 只是展示用的自称，登录时留空则回落到账号名。
- `optionalSession`（`worker/modules/auth.ts`）与 `requireSession` 共用同一个 `resolveSession`，区别只是没会话时返回 null 而非抛 401。**过期 cookie 视同匿名**——带着过期会话来提反馈不该被拦。
- 0018 只按 `collection_tasks.assignee_user_id` 回填采集提交。匿名时代的反馈行保持 NULL：`submitter_name` 是自由文本、`users.display_name` 无唯一约束，靠名字猜会把陌生人的提交挂到别人账号上（同 0010 的判断）。审核端对这两种 NULL 都显示「未登录提交，无法溯源到账号」。
- 前端只有一个 `AccountAuthProvider`（挂在 `App.tsx` 的用户侧壳上）。采集路由用 `AccountGate permission="collect:data"` 强制登录；反馈页用 `useOptionalAccountAuth` 只读状态。原先的 `VolunteerAuthContext` / `VolunteerGate` 是同一件事的重复实现，已删。

## 楼层与楼层图管理（后台 `/admin/floors`）

`worker/modules/floors.ts` + `src/admin/pages/FloorsPage.tsx`。选一栋楼 → 楼层列表（从高到低）→ 单层详情。

**与设施 / 商户的「双向同步」是反查，不是复制**：楼层详情按 `facility_instances.floor_id` / `merchant_outlets.floor_id` 反查，所以在设施编辑器里改了楼层归属，楼层页刷新即变，不存在两份数据对不上。楼层页只做跳转（`/admin/content/facilities/:id`），不复制设施字段——设施内容仍然只能走修订审核流改。

反向一侧：楼层图一旦 `ready`，`FacilityEditorPage` 的服务位置面板立刻能在该图上点选（它按 `floorId` + `svg_viewbox` + `ready`/`published` 找图）。

- **`levelCode` 一律规范化**成 `F<n>` / `B<n>`（`canonicalLevelCode`，`3` / `3F` / `f03` / `B1` / `1B` 都收）。这是 0016 的教训：`createFloor` 原先用 `requiredString` 收自由文本，于是手工建的楼层出现过 `level_code='一层'`，而采集审核流只产出 `F1`，两条写入路径格式不一致，前者在用户端显示成半成品。0016 结尾的契约断言正是这个格式。
- **`levelOrder` 不再信任请求体**，由编号推导（F3→3，B1→-1），否则楼层顺序会和编号打架。
- **删除楼层要求该层全空**：五种引用（设施 / 商户 / 室内空间 / 图纸 / 锚点）任一非零就回 409 `floor_in_use` 并带明细，前端据此说明「先把 3 个设施移走」。想下架而不是删除的，把 `isPublic` 改成 false。
- **`PATCH /api/admin/floor-plans/:id/status` 只能 ready ↔ archived**。`published` 归发版流程，这里挡住，避免出现绕过 release 的第二条发布路径。

## 部署

```
npm run test:all              # typecheck + 151 测试 + 迁移关卡 + build
npm run db:migrate:remote     # 必跑：0018 尚未应用到远端
npm run deploy:cloudflare
```

**这次部署顺序有硬要求**：`0018` 加了 `content_submissions.submitter_user_id`，而新版 worker 的 insert 语句带这一列。先部署 worker 再迁移会让所有提交写入失败，必须**先迁移再部署**。

部署后建议验证：匿名提一条反馈（应当成功且审核端显示不可溯源）、登录后再提一条（应显示账号）、后台建一个楼层并传一张楼层 SVG（导入完成后状态应为「就绪」，且设施编辑器能在该图上点选）。另外照旧：发布一个 release（确认选中的 map version 从 `ready` 升为 `published`）、走一遍照片采纳流、`/api/public/operations` 的 30s 缓存（带 cache-buster 排查）。管理后台凭证向用户索取，不要翻 seed。

## 环境备忘

- **edge 限制**：WebCrypto PBKDF2 ≤ 100k 迭代（本地 workerd 更宽松，`hashPassword` 保持 100_000）
- **D1 远端迁移四条硬限制**（`npm test` 已设关卡，见 `scripts/validate_migration_applicability.mjs`）：禁 temp table、单语句 ≤ 10 万字节、compound SELECT ≤ 5 段、**触发器体内禁用 `CASE`**（远端报 `incomplete input`，本地能过）。守卫写成 `select raise(abort,'…') where <cond>;`
- 迁移永远要在**远端路径**验证，`--local` 过了不代表远端能过
- 本地：`npx wrangler d1 migrations apply shumap-v2 --local`；`ADMIN_BOOTSTRAP_SECRET` 要用 `--var` 传（`wrangler.jsonc` 的 `secrets.required` 会过滤 `.dev.vars`）
- Lody 预览白屏是 Lody 自身 CSP `frame-src` 问题，验收用 Chrome 直开

## 排查经验

- **点击“无反应”先量渲染循环**：批次 8 那个“楼层图点不开”其实路由跳转成功、控制台零报错，真因是 `MapPage` 选中 POI 后陷入无限重渲染（1.5s 内 70 万次 DOM 变更），把 React Router 的过渡饿死。用 `MutationObserver` 数变更次数能一眼定位。
- 成因是 effect 依赖里的**内联新建对象 / 每次重算的数组**：`setViewWindow` 传新对象 → `onViewWindowChange` → 父组件重渲染 → 重建 `featureBindings` → effect 重跑。数值相同但引用每次都新，跳不出来。修法是两端各设一道防线：setter 侧算出相同值时保持引用不变，父组件侧 memo 化依赖。
