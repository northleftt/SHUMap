# SHUMap v2 交接文档

> 更新于 2026-07-22。面向下一个接手的 agent / 开发者，汇总当前进展、已验证事实和剩余缺口。

## 总体状态

v2 重构稿(`前端设计稿/v2重构稿.sketch`)的前端实现 **M1-M13 + D1/D2 + A1-A14 全部完成并提交**,接生产 API(shumap.wangyixuan163.workers.dev)。

## 已完成

- **Phase 0-1(移动端 M1-M13)**:设计令牌(Tailwind 4 `@theme`)、共享原语、响应式壳、地图/POI/校车/楼层/运营事件/事件叠加层/我的/反馈/采集,commit `e6e344d`
- **Phase 2(桌面端 D1/D2)**:自适应三栏布局,commit `68ff17d`
- **Phase 3(管理后台 A1-A14)**:`src/admin/` 嵌套路由重构 + v2 tokens,commit `81b2ebe`
- **采集任务后端 + 审核流补全**(另一个 agent):migrations `0002_collection_tasks.sql`、`0003_public_api_guards.sql`,`collectionTasks.ts` 重写,commit `786aa29`、`065028a`
- **vite dev server 预览修复**:`host: true` + `allowedHosts: true`,commit `b225837`

## 已验证的线上事实(2026-07-20 实测)

- 生产 `/api/public/places/:id` 已返回 `floors` ✅
- 生产 `POST /api/admin/operations/:id/updates` 已部署(401 而非 404)✅
- `worker/modules/facilities.ts` / `merchants.ts` 列表已带 `currentRevisionId` ✅
- 后端 `GeometryType = Point | LineString | Polygon`,locations 存 GeoJSON 不限制类型 ✅
- 移动端 M8 叠加层三种几何都会渲染(Polygon 填充+虚线描边、LineString 虚线+端点)✅

## 剩余缺口

1. ~~**A6 运营事件编辑器:围合区域/道路绘制**~~ **已完成(2026-07-22,未提交)**:`OperationCreatePage.tsx` 重写为点/区域/路径三模式绘制(单击加顶点、回起点/双击/回车闭合、Backspace 撤销、Esc 取消、实时预览),分别存 `event_location`(Point)/`impact_area`(Polygon)/`route_shape`(LineString) 三种 role,几何样式与 M8 叠加层一致。待手动验收
2. **运营事件实时上图修复(2026-07-22,未提交未部署)**:此前 M8 叠加层几何取自 release manifest 快照,新建事件不发版不上图。已改为 `/api/public/operations` 联表 live 下发 locations(`operations.ts`),前端 `buildEventOverlayItems(activeEvents)` 直接用事件自带几何(`MapEventOverlay.tsx` 签名已变)
3. **图层浮卡(2026-07-22,未提交)**:Layers 按钮常驻,点开浮卡 = 事件开关(角标) + 8 类高亮 chips;高亮与搜索快速筛选共享 `activeFilter`,浮卡入口走 `handleFilterHighlight` 不弹抽屉;浮卡 z-40 压过底部抽屉。商户/设施独立标记层暂无数据支撑,未做
4. ~~**`/api/analytics/events` 生产 404**~~ **已自行恢复(2026-07-22 实测)**:生产现返回 204,前后端 payload 校验一致(`map_view`/`poi_view`),无需改动
5. **设计稿对照验收未做**(task #9):用户手动验收;对照图在 `tmp/sketch-preview/*.png`

> 注:1-3 已于 2026-07-22 部署上线(含叠加层按 campusId 过滤、叠加图形点击修复——手势层 pointer capture 会吞图形 click,命中检测走 `data-overlay-event-id` + `onTapOverlayEvent`),生产已实测事件上图+点选弹卡;代码**未提交**。踩过的坑:`/api/public/operations` 响应带 `cache-control: public, max-age=30`,部署后浏览器/代理会拿旧响应,排查时先加 cache-buster 确认。

## 环境备忘

- **Lody 预览白屏已定位为 Lody 自身问题**:其页面 CSP `default-src 'self'` 无 `frame-src`,拦掉了嵌入 `http://127.0.0.1:5173` 的预览 iframe(console 有 169 次 Framing 违规 + 181 次 postMessage origin 'null' 失败)。应用侧无问题,验收用 Chrome 直开 `http://127.0.0.1:5173/map`
- 生产部署命令:`npm run deploy:cloudflare`;edge 限制:PBKDF2 ≤100k 迭代;migrations 需拆分 apply
- 管理后台账号需向用户索取,不要从 seed 脚本翻凭证

## 数据/mock 边界

- 收藏/最近查看/我的反馈记录 = localStorage(`src/lib/storage/`)
- 采集任务已从 mock 切换为真实后端(migration 0002)
- 照片上传仅 UI(submissions 限 64KiB JSON)
