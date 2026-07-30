# SHUMap v2 交接文档

> 更新于 2026-07-30。五个工作流(W-A~W-E)已全部合并进 main,本地回归全绿(typecheck / 55 测试 / build)。**尚未部署**。

## 本轮完成(2026-07-30,commit 0e73fe7..632e3ec)

- **W-A 发布/审核闭环**:422 校验报告可达(ApiError 带 body)、release 激活把选中 map versions 提升为 `published` + 默认发布接受 ready、采纳提交产出的修订直接 `in_review` 入审核队列、运营事件驳回 note 落库(migration 0004)、清理过期兜底
- **W-B 几何编辑闭环**:`PUT /api/admin/operations/:id/locations`(replace-all,单事务,校验先行)、`GET /api/admin/map-features`、SVG 导入现在写 geometry_json/bbox_json(含 `<g>` 包裹解析、曲线端点采样并标记 `metadata_json.approximated`、label 从 text/tspan 提取)、`operations/:id/edit` 编辑路由 + 几何回显、提交带 mapVersionId、校区匹配失败阻断保存
- **W-C 照片/媒体链路**:`POST /api/public/media`(匿名,2MiB 上限,magic-byte 嗅探,30 次/10 分钟/IP)→ quarantine → 审核采纳时 R2 拷贝到 `public/media/` 发布(migration 0005);反馈/采集三处照片槽位真上传(客户端压缩);审核端看图(`GET /api/admin/media/:id/content`);照片经修订→发布流进 M2;M2 照片轮播(scroll-snap + 真分页点)
- **W-D 商户链路**:manifest.merchants 按 hostPlaceId 归组进楼宇、M2 详情商户区块 + 同 sheet 商户视图(菜单/档口号/人均)、A12 菜单子表编辑、桌面端商户面板;**顺带修复**:商户/设施因无 anchor 导致 campusId=null 被搜索静默过滤(现继承 host place 的 campus)
- **W-E M5 楼层平面图**:`GET /api/public/maps/:mapVersionId/asset`(仅 active release 成员可读,类型白名单+nosniff+sandbox CSP)、A10 支持楼层图上传(floor_svg + floor_id)、FloorsPage 列表/平面图切换 + 设施锚点徽章 + 无图纸回退列表;SVG 注入前经 `sanitizeSvg` 白名单净化;修复 assertExists 对 buildings(place_id 主键)的 500

浏览器冒烟(本地 wrangler + 真实链路数据):M5 平面图渲染/徽章选中/缩放/无图回退零 console 错误;W-B/W-C 各自做过本地鉴权往返(21/21 与 7 步回环)。

## 部署清单(下次 `npm run deploy:cloudflare` 前)

1. **先 apply 两个新 migration**:`npm run db:migrate:remote`(0004_operational_event_review_note、0005_submission_photos;按惯例注意 migrations-apply 触发器拆分问题)
2. 部署后生产验证:发布一个 release(验证 map version 提升 published + 默认发布)、上传一张照片走完采纳流、`/api/public/operations` 缓存 30s(排查带 cache-buster)
3. 管理后台凭证向用户索取,不要翻 seed

## Backlog(各工作流报告的遗留,按值得做的顺序)

- 校验失败的 release 会留孤儿 release_items/search_documents(W-A)
- 隔离区照片无清理 cron;防滥用仅 IP 限速;照片采纳全有全无、无逐张选择(W-C)
- 商户链路未用真实发布数据端到端验证;商户视图不显示楼层;桌面商户面板需对照 D1 设计稿过目(W-D)
- A11 设施编辑器仍不能编辑 service_position 锚点(M5 徽章数据要靠它才能长出来)——建议下一轮做
- 曲线要素为端点采样近似(metadata_json.approximated 可查);shape_hash 未写(W-B)
- submission 决定因唯一索引不可复审;运营事件 reject 后端不强制 note(W-A)
- A5 发布中心仍无历史列表接口,回滚要手输 release ID
- M2 照片区、M6 进展时间线、M10 收藏列表页/关于/设置、M12 下拉刷新等审查时发现的半成品(见 2026-07-30 审查报告)

## 环境备忘

- Lody 预览白屏是 Lody 自身 CSP frame-src 问题,验收用 Chrome 直开
- 本地验证:`npx wrangler d1 migrations apply shumap-v2 --local`;`ADMIN_BOOTSTRAP_SECRET` 要用 `--var` 传(wrangler.jsonc 的 secrets.required 会过滤 .dev.vars)
- edge 限制:PBKDF2 ≤100k 迭代
- 收藏/最近查看/我的反馈 = localStorage;反馈状态仍无公共查询端点
