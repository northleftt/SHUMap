# SHUMap v2 交接文档

> 更新于 2026-08-03。已部署到生产（version `8370414e`，bundle `index-B6nbKr_T.js`）。
> 本地回归全绿：typecheck / 121 测试 / 15 迁移可应用性 / build。远端 D1 无待应用迁移。
>
> 本文档每条待办都在 2026-08-03 逐条对代码核过。改动代码后请同步这里，不要让它再次腐烂。

## 当前状态

- **线上**：https://shumap.wangyixuan163.workers.dev ，active release `v2026-07-18-initial`（121 places、8 条线路、3 个校区级地图版本）
- **迁移**：`0001`–`0016`（`0007` 从未存在，不是丢了）。远端 `npm run db:migrate:remote` 返回 `No migrations to apply!`
- **测试**：`npm test` = 121 单测（18 个文件）+ schema 校验 + 迁移可应用性 + 切分检测器自测；`npm run test:all` 额外带 typecheck 与 build
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

**1. M5 楼层平面图无数据可看（当前最影响观感）**
页面能进、代码通了，但线上 manifest 里 `maps` 3 条全是校区级（`floor_id: null`），楼层级图纸 0 条；`floors` 仅 1 条（A 楼 1 层）、`facilities` 0 条、`service_position` 锚点 0 条。因此所有楼宇都不出现 `平面图` 切换入口，只显示列表版“该楼层暂无设施信息”。代码路径已就绪（A10 支持 `floor_svg` + `floor_id` 上传，A11 可标锚点），缺的是录入。

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

## 部署

```
npm run test:all              # typecheck + 121 测试 + 迁移关卡 + build
npm run db:migrate:remote     # 有新迁移时先跑；当前返回 No migrations to apply
npm run deploy:cloudflare
```

部署后建议验证：发布一个 release（确认选中的 map version 从 `ready` 升为 `published`）、走一遍照片采纳流、`/api/public/operations` 的 30s 缓存（带 cache-buster 排查）。管理后台凭证向用户索取，不要翻 seed。

## 环境备忘

- **edge 限制**：WebCrypto PBKDF2 ≤ 100k 迭代（本地 workerd 更宽松，`hashPassword` 保持 100_000）
- **D1 远端迁移四条硬限制**（`npm test` 已设关卡，见 `scripts/validate_migration_applicability.mjs`）：禁 temp table、单语句 ≤ 10 万字节、compound SELECT ≤ 5 段、**触发器体内禁用 `CASE`**（远端报 `incomplete input`，本地能过）。守卫写成 `select raise(abort,'…') where <cond>;`
- 迁移永远要在**远端路径**验证，`--local` 过了不代表远端能过
- 本地：`npx wrangler d1 migrations apply shumap-v2 --local`；`ADMIN_BOOTSTRAP_SECRET` 要用 `--var` 传（`wrangler.jsonc` 的 `secrets.required` 会过滤 `.dev.vars`）
- Lody 预览白屏是 Lody 自身 CSP `frame-src` 问题，验收用 Chrome 直开

## 排查经验

- **点击“无反应”先量渲染循环**：批次 8 那个“楼层图点不开”其实路由跳转成功、控制台零报错，真因是 `MapPage` 选中 POI 后陷入无限重渲染（1.5s 内 70 万次 DOM 变更），把 React Router 的过渡饿死。用 `MutationObserver` 数变更次数能一眼定位。
- 成因是 effect 依赖里的**内联新建对象 / 每次重算的数组**：`setViewWindow` 传新对象 → `onViewWindowChange` → 父组件重渲染 → 重建 `featureBindings` → effect 重跑。数值相同但引用每次都新，跳不出来。修法是两端各设一道防线：setter 侧算出相同值时保持引用不变，父组件侧 memo 化依赖。
