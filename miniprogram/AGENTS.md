# SHUMap 小程序端 — agent 工作须知

原生小程序（TS + glass-easel），Skyline 渲染引擎。代码在 `miniprogram/miniprogram/`。
已完成：校车时刻表（Part 4）、release 数据通路（Part 1）、地图 canvas 引擎（Part 2）、搜索/POI 详情/楼层图/图层筛选/运营事件（Part 3）。返校指南（Part 5）三刀已齐：`lib/guide.ts` 数据层 + `pages/guide/guide` 骨架 + route 卡 + figure 图示卡（-png 键回落）+ sceneGuide 实景指引 + 线路位图图标 + 枢纽指引图（guideFigures）+ 实况视频入口（guideVideos）+ 备注（remark 富文本 rich-text）。模拟器巡检已过：脚本 `scripts/miniprogram-guide-automator.mjs`（主仓库，截图 `tmp/guide-autotest/`），剩余真机联调验证。

## 已踩过的坑（务必遵守）

1. **`Page({...})` 选项里不能写 getter**：glass-easel 合并选项时会把 getter 当场求值成静态值（此时 `this.xxx` 还是初始值），之后永远拿到旧值。用普通方法替代。
2. **不能 `require` .json 数据文件**：编译器只打包源码模块，`require('*.json')` 运行时抛 `module 'xxx.json.js' is not defined`（页面直接空白）。数据文件一律改成 `.ts` 模块 `export default`，参考 `data/academic-calendar.ts`、`data/shuttle-schedule.ts`。
3. **Skyline 页面必须配 `"navigationStyle": "custom"`**（页面级 json），否则编译报错；状态栏占位用 `wx.getWindowInfo().statusBarHeight` 自己处理。Skyline 在页面级开启：`"renderer": "skyline"`。
4. **`project.config.json` 禁止重复键**：`setting.useCompilerPlugins` 已含 `["typescript"]`，再写一次会被后面的值覆盖导致 TS 不编译、页面报"未找到 xxx.js"。改配置前先全文检查重复键。
5. **miniprogram-automator 对 Skyline 页面的限制**：`page.data()`/元素选择/`tap` 均不可用（无 webview 渲染层），**截图可用**；逻辑层验证用 `miniProgram.evaluate` + console/exception 事件监听（能抓到真实运行时异常，很有效）。web-view 页面截图为空白（内容在原生层），属工具限制，不算 bug。另注意：automation 会话是单客户端的，automator 进程被强杀后会话可能仍被占用，表现为下一次 `automator.connect` 永久挂起——重跑一次 `cli auto` 重建会话即可。
6. **后端数据源（方案 B）**：`config.ts` 的 `apiBaseUrl` 指向**线上 Worker** `https://map.shutf.com`，日常开发不依赖本地 D1，也不要再让本地 wrangler dev（8788）承担数据源。开发者工具"服务端口"开启后可用 CLI：`cli open`/`cli preview`/`cli auto`；**preview 需要 IDE 已登录，auto 不需要**。注意：workers.dev 未备案，真机/上线必须走云托管代理（`useCloudContainer: true`），本地开发依赖开发者工具的 `urlCheck: false`。
7. **worklet 捕获的外部变量是序列化快照**（官方文档：捕获时序列化拷贝到 UI 线程、对象被 freeze、后续修改不同步）。onLoad 之后才赋值的可变配置（如手势用的 mapCfg/planCfg 普通对象）在 worklet 里永远是初值 → 真机手势全部静默失效（Part 2/3 踩过；automator 驱动不了 Skyline 手势、一直 evaluate 直调绕过，所以模拟器上发现不了）。**worklet 要读的每一项配置标量都必须放 `wx.worklet.shared()`**，赋值时先置 ready=false、赋完置 true 避免半更新。
8. **`worklet:ongesture` 绑定在本环境真机上完全不触发**（glass-easel + TS + 当前基础库的组合；屏上诊断确认回调零次执行，而同页面 bindtap 正常、worklet 本身没坏——applyAnimatedStyle 渲染/动画都正常，原因未查明）。**手势识别已整体改为 JS 线程触摸事件**（`.map-surface`/`.floor-surface` 上的 `bindtouchstart/bindtouchmove/bindtouchend/bindtouchcancel/bindtap`）+ `lib/map/viewport.ts` 纯函数，不要再回到 gesture-handler + worklet:ongesture 方案。渲染层不变：`winX/winY/winScale` shared 变量 + `applyAnimatedStyle`（真机已验证正常）。额外收益：automator 可以 evaluate 直调事件处理器做真端到端手势验证（map automator 4.5 节的 pan/pinch/tap 模拟）。
9. **WebView 渲染降级模式（模拟器切「当前渲染模式: WebView」）下 `applyAnimatedStyle` 只在注册时匹配一次既有节点**：setData 重建的节点（如切校区/筛选后的 `.poi-pin` 列表项）吃不到动画样式——图钉反向缩放丢失，退化为世界固定尺寸、随缩放巨大化（viewBox 最小的嘉定最夸张）。真机 Skyline 是动态匹配，不受影响。对策：每处重建图钉节点的 setData 回调里调 `refreshPinAnimatedStyle()` 重注册（map.ts；同选择器覆盖语义，Skyline 下无副作用）。验证用 automator：`selectAll(".poi-pin").boundingClientRect()` 在程序化缩放前后宽度应恒定。

## 工程现状（2026-08-24：底部抽屉整卡可拖）

- **拖拽命中区从 28px 把手扩到整张卡片**（用户反馈：细把手太难瞄）。归属判定是
  **空间的**——手指落点在纵向滚动框（`.sheet-scroll`）里归列表滚动，落在别处
  （搜索行 / 标签筛选标题行 / 「最近查看」标题行）归卡片拖动。不看 scrollTop、
  不看时序，所以两端同一套规则、也不需要跨线程读滚动状态。纯函数在
  `lib/map/sheet.ts`（`sheetGestureOwner` / `resolveSheetDragOwner` /
  `snapSheetModeWithVelocity` / `dampSheetTop` / `shouldClosePoiOnRelease` /
  `sheetDragVelocity`），Web 端镜像在 `src/components/sheet/sheetGesture.ts`，
  用例同一组（`tests/miniprogram-map-sheet.test.mjs` + `tests/sheet-gesture.test.mjs`，
  后者还断言两端常量一致 + 三处接线都在）。
- **home 档列表照常滚**（用户明确选的方案）：抬档得抓卡片上半部分或点全屏钮。
  代价是 home 档下上滑滚列表而不抬档，收益是最近查看 6 条在 home 档就能翻完。
- **results / poi 档保留「滚到顶继续下拉 = 降档 / 关详情」出口**（iOS 习惯；这两档
  列表占九成面积，纯空间规则下降档就只剩把手）。实现上零成本：滚到顶后继续下拉在
  scroll-view 内部是无效动作，冒泡上来的 touchmove 直接驱动抽屉，**不需要打断任何
  原生滚动**——这是该方案在小程序侧能成立的根本原因。`bounces="{{false}}"` 必须加，
  否则 iOS 橡皮筋会吃掉到顶后的下拉。
- **`sheetScrollAreaHitAt` 存时间戳而不是布尔**：Skyline 下 scroll-view 的 touchstart
  是否冒泡到祖先**未经真机确认**（坑 #8 系）。若不冒泡，`.sheet-shell` 的处理器就没有
  机会消费清零，布尔标记会漏到下一轮触摸、把之后**每次**整卡拖动都误判成列表滚动
  （功能静默失效）。时间窗（200ms）只在同一轮触摸内有效，最坏是本轮判定失准，不会粘住。
- **松手落档补速度**：整卡可拖之后手势变短变快（不再瞄准把手），只看位移投影会
  「甩了一下没换档」。速度取最后两个采样点（全程平均会把中途的犹豫算进去）；
  `|v| > 0.5px/ms` 无条件走相邻档，否则按 150ms 外推再取最近档。poi 关闭条件同步
  加了速度分支。越界从硬 clamp 改阻尼（×0.3）。
- **抢到手势的副作用**：置 `sheetTapSuppress`（被 `openResultRow`/`openRecentRow`/
  `onSearchFilterTap` 开头的 `consumeSheetTap()` 消费，避免拖完误开 POI）、
  `wx.hideKeyboard()`（results 档带着键盘拖卡片会错位）、起点重置到当前位置
  （判定用掉的 8px 不算进位移）。降档时 `resetSheetScroll()` 把列表滚回顶部
  （`scroll-top` 在 0/0.5 间交替——传相同值不会重新滚动）。
- **`measureSheetScrollable()`**：内容没溢出的框（最近查看只一两条）不该吃手势，
  此时整卡可拖。在 configureSheet 的 setData 回调 + refreshRecents/refreshSearchRows
  之后实测，异步无妨（早于用户下一次触摸）。
- **真机待验三条**：① scroll-view 的 touchstart 是否冒泡到 `.sheet-shell`（不冒泡则
  「非滚动区整卡可拖」失效，退路是非最高档时盖透明捕获层，但那层会吃掉 tap 得手动
  转发，属最后手段）；② results/poi 档滚到顶下拉降档是否顺；③ 甩动阈值手感。
  采样脚本复用 `tmp/map-test/sheet-anim-sample.mjs`（evaluate 直调
  `onSheetTouchStart/Move/End` 序列，断言 sheetY 轨迹单调、落点正确）。

## 工程现状（2026-08-12：用户定位 dot / 定位按钮）

- **用户定位已上线**（wx.getLocation 接口权限已获批；`wx.onLocationChange`/
  `wx.startLocationUpdate` **未获批，禁止使用**，app.json `requiredPrivateInfos`
  只保留 `"getLocation"`，提审会被未获批接口拦截）：
  - 纯逻辑在 `lib/map/user-location.ts`：`isInsideViewBox`（dot 只在当前校区
    viewBox 内显示）、`metersToViewBoxUnits`（米→viewBox 单位，经度方向近似
    95150m/°）、`computeUserLocationMarker`（校区外返回 null；accuracy 非法或
    >500m 时 radius=0 不画精度圈）、`campusKeyForGcj02Point`（gcj02 → 属于哪个
    校区，入参每校区 geoTransform+viewBox，viewBox 原点可能非零需先减原点）。
    单测 `tests/miniprogram-user-location.test.mjs`。
  - 页面侧（pages/map/map）：boot 成功后 `startUserLocationPolling`（立即一次 +
    每 30s `wx.getLocation({type:'gcj02'})` 轮询；onHide 停、onShow 恢复、onUnload
    清理）；轮询失败（含未授权）一律静默，**只有点定位按钮才 toast**。
  - **校区地理边界缓存 `this.campusGeoBounds`**：boot 时对三校区 `svgRaw` 各做
    一次 `parseSvgViewBox`（配上 geoTransform），之后的轮询/按钮路径只复用缓存，
    不重复解析 SVG。
  - **按定位自动选校区**：boot 后**首次** getLocation 成功时，落在非当前校区则
    `setupCampus` 自动切过去（`autoCampusSwitchDone` 只放行一次；之后 30s 轮询
    不再自动切，尊重用户手动切校区）。**定位按钮不受此限**：每次点击刷新定位后
    若在另一校区内，先 `switchCampusForUserFix` 切过去再居中聚焦 dot；不在任何
    校区 toast「当前位置不在校区范围内」且不居中（居中会被 clamp 到校区边缘）。
  - 渲染：蓝点白描边 `.locate-pin`/`.locate-dot` 复用 `.poi-pin` 反向 scale 保持
    屏幕尺寸（同 eventMarkers 范式）；精度圈 `.locate-accuracy` 是**世界坐标尺寸**
    （随地图缩放，表示真实米数），放在图钉层之下。
  - 定位按钮在 `.control-column` 最上方（crosshair 图标）：立即刷新一次定位 →
    跨校区先 `setupCampus` → `focusPointWindow`（campus 的 selection* 参数，
    同 selectAt）动画居中。校区切换后按 `lastUserFix` 重算 dot。
    report 增 `userLocation` 供 automator evaluate 核对。

## 工程现状（2026-08-10：地图页 UI 细节 / 抽屉动画 / 手势手感打磨）

- **2026-08-10 UI 修订**：右侧控件列的「回到校区中心」（crosshair）按钮已移除
  （当时小程序无定位能力，`resetView()` 方法保留供 automator 直调）；
  **2026-08-12 起定位按钮已加回控件列**（见上条「用户定位」），控件列 = 定位 + 图层；
  图层浮卡 `.layer-card` z-index 提到 **90**——压过跟随抽屉顶边的 `.sheet-toggle`（80），
  否则全屏浮钮会浮在浮卡表面上；校区 pill 平面化（见下「校区切换」条）；
  poi 档抽屉高度内容自适应（见下「详情 sheet」条）。
- **2026-08-10 关详情回退修订（Web 端同步）**：closePoi/clearSelection 回退到打开
  详情前的完整状态——档位原样回退（`previousModeBeforePoi` 不再把 collapsed 记为
  home：全屏回全屏、搜索/筛选回 results、默认回 home）；图层浮卡开详情时临时收起、
  关详情原样恢复（`previousLayerPanelOpen`，与 previousSheetMode 同一守卫，
  详情间切换不覆盖）；**校车 tab 深链**（shuttle.ts `openStopOnMap` 写
  `shumap.pending-map-poi-return`）打开的详情，关闭后 `wx.switchTab` 跳回来源 tab
  （`poiReturnTab`，只在 poi 档关闭时生效；直开另一详情、手动切校区都会清标记，
  campus: 深链不记录）。poi 档关闭圆钮移到 `.sheet` **之外**：整体抬到卡片上缘之上
  （`sheetCloseTop = max(controlTop, sheetTop − 48)`，抽屉太高时钳到胶囊/控件列之下），
  不再半压卡片遮挡收藏/标题；Web 端同式（MapPage `poiCloseTop/poiCloseRight`）。
- **2026-08-10 第三轮修订（真机反馈）**：搜索 input 加 `adjust-position="{{false}}"`
  （真机 Skyline 键盘弹出时 adjust-position 默认行为把 results 档输入框渲染错位）；
  **抽屉全屏（results 档）只在「输入搜索 query」或「主动点全屏浮钮」时发生**——
  onSearchFocus 不再强制 results（仅 collapsed→home 抬一档让结果区可见），
  toggleFilter/resetFilters 不再动档位（chip/图层开关只改筛选与高亮）；
  图层浮卡改 wxml 内联 `left: viewportWidth − 264px`（真机 Skyline 上 `right:16px`
  + 内层 scroll-view 会让卡片右缘溢出屏幕，devtools 复现不了），
  `.layer-card-scroll` 加显式 `width:248px; box-sizing:border-box`；
  **pinch 锚定模型重写**（见下「手势」条）并新增单指「轻触后按住滑动」缩放。
- **2026-08-10 results 档按钮布局**：results（近全屏）档抽屉顶边贴近胶囊行，
  浮动全屏钮会被顶进微信胶囊、图层钮会浮在卡片上——该档 `sheetToggle` 置 null
  （浮动钮不出），收起功能改由**搜索条行内收起钮**（`.search-row` +
  `.search-collapse`，扁平灰底与搜索条同质，点击 = toggleSheet → collapsed）；
  右侧控件列与图层浮卡 results 档整体不渲染（layerPanelOpen 状态保留，退出档回来）；
  返校指南横幅（guide-banner，浮在胶囊行下）results 档同样不渲染——
  它与抽屉顶边同高，不挡会盖住搜索条。
- **2026-08-11 运营事件修订**：事件详情弹卡限高 `max-height: 62vh` +
  `.modal-scroll` flex:1/min-height:0/显式宽度（真机 Skyline 不限高会把卡片
  顶出屏幕顶部、时间行文字溢出右边界——devtools 复现不了，`.fact-value`
  max-width 62% 右对齐换行兜底）；**事件区域可点**：`eventRegionHit`
  （operations.ts 纯函数，Polygon/MultiPolygon 偶奇规则含洞、LineString 线段
  距离 ≤ tolerance，Point 仍走锚点）接入 handleTapAt，优先级 = 图钉 → 事件锚点
  → **事件区域** → 楼宇（对齐 Web 端 MapEventOverlay 整图形 pointer-events；
  小程序 overlay 是栅格图不接收手势，命中手动算）；摘要卡操作行加
  **「暂时关闭」**（`dismissEvents`：eventsOn 置 false、收摘要卡、清 overlay，
  不持久化——下次进页面自动恢复；toast 提示「已暂时关闭，可在『图层』重新打开」，
  重新打开的位置 = 图层浮卡运营事件开关）；`.event-card` z-index 70→**85**——
  跟随抽屉顶边的全屏浮钮（80）底缘正好落在摘要卡操作行上，会挡住
  「查看详情/关闭」（layer-card 同款坑，见坑 #9 系）。
- **`.sheet` 必须是完全静态节点（闪跳根因 A 的修复）**：不挂任何 `{{}}` 数据绑定、
  不挂 `wx:if`——只要节点自身有绑定，任何一次无关的 setData 提交都会重算样式，
  顶掉 worklet 的 transform 一帧（卡片弹到目标顶边→缩回→重进动画）。结构固定为
  `<view wx:if="{{ready}}"><view class="sheet"><view class="sheet-frame"
  style="height: {{sheetFullHeight}}px;">…</view></view></view>`：高度这类必须走
  setData 的样式一律放内层 `.sheet-frame`；collapsed 档的内容门控也写在内层
  （`wx:if="{{sheetMode !== 'collapsed'}}"`）。translateY 只走 sheetY worklet 一轨，
  WXSS 里 `.sheet { transform: translateY(110%) }` 只是 worklet 接管前的屏外初始位
  （接管后被 applyAnimatedStyle 覆盖）。上一轮残留的 `data.sheetStyleTransform`
  兜底已删除。
- **动画同 tick 合并赋值（闪跳根因 B 的修复）**：实测同 tick 对 shared 变量连赋两次
  timing（先直写 value、再 timing 到目标）会把抽屉停在 translateY(0) 附近。现在
  configureSheet(animate=true) 只记 `sheetPendingTop`，`setTimeout(0)` 统一 flush
  一次：flush 时读 `sheetY.value` 实时值、距目标 <0.5 跳过、否则按
  `sheetAnimateMs(target-live)` 时长 + easeOut timing。flush 中 `sheetTouch` 活跃
  （正在拖拽）时跳过；onSheetTouchStart 开头清 pending（拖拽作排队等候动画）。
  animate=false 清 pending 直写。同一 evaluate 内 openDetailByKey+clearSelection+
  setSheetMode 连调也只触发一次动画（采样验证通过）。
- **ease-out + 时长分档（跟手性）**：onLoad 缓存
  `this.easeOut = wx.worklet.Easing.bezier(0.22, 1, 0.36, 1)`（无 Easing 时守卫降级
  为默认线性）；`lib/map/sheet.ts` 的 `sheetAnimateMs(distancePx)` 分档
  （≤260px → 160ms，否则 240ms），抽屉档位切换与 animateToWindow（聚焦/缩放按钮）
  都挂 easeOut。采样脚本 `tmp/map-test/sheet-anim-sample.mjs`（automator evaluate
  每 ~16ms 高频采 sheetY.value）7 条转场全过：单调、不靠近 0、落点正确、
  hasBezier:true。
- **动画起步 tick 减负（帧率优化，`deferAfterSheetAnim`）**：动画 flush 是
  `setTimeout(0)`，排在同 tick 全部同步重活之后——同步块越长，动画起步越晚、
  其 setData 提交还和动画头几帧抢渲染（「卡一下再动」）。所以与动画首帧无关的
  重活一律 `deferAfterSheetAnim(work, animateHint)` 延后到动画结束之后
  （setTimeout 用 `SHEET_ANIMATE_MS_LONG` + 40ms 缓冲；animateHint=false 退化
  为让出当前 tick）。已延后的：selectAt 的 `applyHighlight`（大 SVG 注入 +
  同步写盘；带过期守卫——延后窗口内改选/清选中则作废）、configureSheet 离开
  poi 档时的 `syncFilterHighlight` 恢复、openDetailSheet 的
  addRecent/refreshRecents/updateReport、selectAt/clearSelection 的
  updateReport。**保持同步的**：detail setData（标题随动画看到，拆开会
  「先空后闪」）、recomputeMarkers（this.mapMarkers 是 hitTest 输入，动画窗口内
  再点图钉不能读旧集合）、selected setData。测量脚本
  `tmp/map-test/anim-block-measure.mjs`（各 7 次取中位，devtools 宿主机）：
  openPoi 楼宇 40→21ms、openDetailByKey 18→12ms、closePoi 13→11ms。
- **抽屉图层不拆分（评估结论）**：考虑过把「可见带（圆角+阴影+内容）」和
  「底部填充（纯白）」拆两层，结论不拆——Skyline 对 transform 动画只跑合成，
  阴影/圆角属静态层内容只栅格化一次，拆层后纹理总面积不变（合起来仍
  ~sheetFullHeight 高）且合成节点 +1；两个可行拆法都有实害：填充层挂偏移
  {{}} 绑定 = 在动画子树重引入 setData 样式绑定（根因 A 同款），或两个兄弟
  节点各挂 applyAnimatedStyle = 拖动中拼缝露地图的风险（现模型的存在意义
  就是防露缝）。瓶颈在起步 tick 的 JS 提交（上一条已处理），不在合成。
- **collapsed 档不再被 tab 栏压住**：onLoad 用 `wx.getWindowInfo().safeArea` 算
  `safeBottom`（与 custom-tab-bar 同口径），configureSheet 的 tabBarHeight =
  64 内容 + safeBottom（ sheetHeights 签名不变，纯函数吃总高）。
- **手势**：`TAP_MOVE_TOLERANCE_PX = 8`——单指位移超阈值或捏合后置 `tapSuppress`，
  随后的 bindtap 被消费掉（拖完地图误开 POI/误关详情的修复）；automator 直调
  onSurfaceTap 前要注意这个标记（4.5 节 tap 测试已改成真实 touchstart→touchend→tap
  序列，并新增「拖动后 tap 应被抑制」断言）。onSheetTouchStart 用 `sheetY.value`
  实时值起拖并直写覆盖进行中的 timing（吸附动画内再抓把手不跳变）。
- **pinch 锚定模型（2026-08-10 重写）**：旧模型 `zoomWindowAt(beginWin, 当前中点, …)`
  锚的是起点窗口下「当前中点位置」的世界点，中点一动锚点就换——单侧手指快图往
  快侧拽、双侧都快反向滑。新模型：手势起点中点换算世界坐标 `anchorWorld`（恒定），
  每帧 `pinchWindow(anchorWorld, 当前中点, …)` 让该世界点跟住当前中点屏幕位置
  （viewport.ts 有纯函数 + 单测；中点平移 = 世界锚点 1:1 跟随）。**单指缩放**：
  轻触（未拖动 tap，350ms 内、30px 内再次按下）后按住滑动 = zoomDrag，
  下滑放大/上滑缩小，`scale = beginScale * 2^(deltaY/128)`，锚点=按住点；
  zoomDrag 无条件 tapSuppress。pan 数学不变（仍与 Web 端同式）。
- **图标整体上调一档**（用户真机反馈偏小，系统性 +20%~30%）：图钉 36→44、
  poi-circle 26→32/poi-icon 22、event-pin 32、列表行方块 40→48/icon 19→24、
  chip 高 32→40/字号 13→15、浮钮与缩放钮 44→48、guide banner icon 26、
  详情 detail-fav/detail-back 44/icon 22、sheet-toggle/close 22/40 等
  （全清单见 map.wxss diff）；custom-tab-bar 图标 22→26、文字 11→12/15→16。
- 单测 `tests/miniprogram-map-sheet.test.mjs`（sheetHeights 四档公式 +
  collapsed 底边贴 tab 栏顶回归 + snapSheetMode/落档规则 + sheetAnimateMs 分档）。
  一次性验证脚本在 `tmp/map-test/`（sheet-anim-sample.mjs 采样、icons-shots.mjs 截图）。

## 工程现状（Part 0：微信云托管代理，2026-08-07 已上线）

- **staging 环境切换（2026-09-17）**：`config.ts` 模块加载时读 wx storage 键
  `shumap.env` 并覆盖 `apiBaseUrl`/`webBaseUrl`/`cloudService`（纯逻辑 `lib/env.ts`，
  单测 `tests/miniprogram-env-switch.test.mjs`）；非 `staging` 一律按生产。
  入口在 debug 页（pages/debug/debug）顶部「运行环境」：清 release/map-asset 缓存
  → 写 storage → `wx.restartMiniProgram` 重启生效。staging 反代服务
  `cloudrun/shumap-api-staging/`（server.mjs 与生产逐字节一致，仅 Dockerfile 上游
  不同，漂移门禁 `tests/miniprogram-cloudrun-staging-proxy.test.mjs`）**已部署**
  （2026-09-25，devtools 与真机/体验版都可直接走云托管通道测 staging；
  `PROXY_SHARED_SECRET` 未配，仅影响 Worker 限流退回按 IP 计数）。
  全量说明见主仓库 `docs/staging.md`。
- `cloudrun/shumap-api/`：零依赖 Node 反向代理容器（`server.mjs` + `Dockerfile`，监听 80），
  已部署到云环境 `cloudbase-d1gse9nsp7630b4e7`（个人版，ap-shanghai）服务 `shumap-api`。
- **上游是 Worker 自定义域名 `https://map.shutf.com`，不是 workers.dev**：
  workers.dev 在大陆被网络阻断（容器出口实测 ETIMEDOUT）；自定义域名挂 Cloudflare
  Workers Custom Domains（shutf.com zone，走 anycast 正常）。重新部署/换域名见
  `cloudrun/README.md`（CloudBase CLI 一键部署，含三个坑：开通资源 API、首建 push 重试、
  content-encoding 必须剥离否则 callContainer -1000061）。
- 小程序端：`config.ts` `cloudEnv` 已填、`useCloudContainer: true`（IDE 模拟器全链路验证
  通过：release 装配 + 地图页 SVG 资产 automator 均与后端一致；要直连本地调试可临时改回
  false）。`app.js` 的 `wx.cloud.init` env 读 `config.ts` 的 `cloudEnv`。
- 单测 `tests/miniprogram-cloudrun-proxy.test.mjs`（stub 上游断言 query/SVG/404/POST
  透传 + content-encoding 剥离）。**真机预览验证待做**（链路在模拟器已全通）。

## 工程现状（Part 3：搜索/POI 详情/楼层图）

- `lib/release/search.ts`：本地搜索，复刻服务端 publicSearch 规则（normalizeSearchText 同式、
  normalizedText 子串匹配、rankingWeight desc + title asc、cap 50），数据源是 manifest 冻结的
  searchDocuments。`resolveSearchHits` 做 poiKey 折叠（带 buildingPlaceId 折叠到宿主楼宇；
  楼宇 bare id 直接命中；facility/merchant 带前缀；商户折叠带 merchantId；
  `visibility.search === false` 跳过；按 poiKey 去重保序）。`foldDocPoiKey` 是折叠的单条版本，
  页面取副标题与 resolveSearchHits 共用，别再造一份。
- `lib/recents.ts`：「最近查看」（wx storage key `shumap.recents`，上限 20 最新在前去重），
  纯函数核心 + storage 注入（同 loader deps 范式），页面用默认 wx 实现 `addRecent`/`listRecents`。
- `lib/release/facilityStatus.ts`：状态徽标文案（unavailable→暂停使用、
  partially_available→部分可用，available/unknown 不出徽标），地图页与楼层图页共用。
- `MapPoi.navigationPoint`（GCJ-02 `{longitude, latitude, displayName}`）：详情 sheet「导航」
  按钮直接喂 `wx.openLocation`，不用走 navigationUrls 外链。
- 主题色：**蓝 `#1e80c1`**（按压 `#125b8b`，选中浅底 `#e8f1f8`，对齐 Web 端 `src/index.css`
  与设计稿；早期地图页用的绿 `#2f6b4f` 是错的，已全部改掉）。UI 尺寸用 px。
- 地图页（pages/map/map）增量：
  - 顶部搜索条 → 全屏搜索面板（z-index 200，不透明底；input focus + 180ms setTimeout 防抖，
    逻辑层防抖即可不用 worklet）；空 query 显示最近查看前 6 条（poi 已不存在的跳过）。
  - 校区切换：**地图视口左上角浮动 pill + 下拉白卡**（对齐 Web 端 CampusSwitcher，
    不是 chips 横排；2026-08-10 起 pill 改**平面样式**：去阴影、1px `#e8ebef` 细边框，
    对齐微信胶囊质感，Web 端同步）。手动切换 = 全量重置（对齐 resetForCampus：清选中/详情、关搜索面板、
    收起下拉、视口回校区预设焦点）；从搜索结果跨校区打开 POI 的 openPoi 路径例外，
    保留选中与详情。`switchCampus(e)`（读 dataset.key）保留下拉项与 automator 直调。
  - 点结果/最近项 `openPoi`：关面板 → 跨校区先 `setupCampus` → 复用 `selectAt` 聚焦动画
    （点 POI 用 markerPoint，楼宇用 buildingShape center）→ 开详情 sheet → addRecent。
  - 选中态（取代 Part 2 的大蓝圈 select-ring，已删）：**楼宇 = 高亮 SVG 覆盖层**
    （`svgRaw` 的 `</svg>` 前注入与 Web 端 `g[data-selected]` 逐字一致的选中 CSS——
    浅蓝填充 `rgba(215,232,243,1)` + `#1e80c1` 描边 3，写唯一文件名的本地临时 SVG 到
    `USER_DATA_PATH`，同尺寸同定位第二张 `<image>` 盖底图上，清除时异步删旧文件）；
    **点状 POI = 图钉 `poi-pin-selected` 样式**（浅蓝光晕 + 实心蓝点，markers 带
    `selected` 布尔）。report 增 `highlightActive/selectedMarkerPoiKey`。
  - 详情 sheet（取代原 selected-card）：sheet-mask/sheet 范式 + scroll-view；
    **poi 档高度内容自适应（2026-08-10，Web 端同步）**：可见高度 = `.detail-measure`
    实测自然高度封顶 `heights.poi`（min(h×0.74, 620)），内容少抽屉坐低、不预留空白。
    注意 **wx:if 门控 `sheetMode==='poi'`**，从别的档位直接量不到节点——openDetailSheet
    分两步：setData 直置 `sheetMode:'poi'`（抽屉物理位置不动、节点先上树）→ 回调里
    `measurePoiContentHeight` → `configureSheet('poi', true)` 动画到实测目标；
    测量失败回落上限。商户子视图切换（openMerchantRow/backFromMerchant）同样重测。
    展示数据在 JS 侧一次算好（media 过滤 floorLevelCode、以 `/` 开头的 url
    拼 config.apiBaseUrl、label 含"电话"的 facts 可点 makePhoneCall）；楼宇有设施时行尾
    「查看楼层图 ›」navigateTo 楼层图页；商户在 sheet 内切子视图（返回键回主视图）。
  - 图层筛选（2026-08-07 增量，对齐 Web 端 useMapPageState）：
    - 纯逻辑在 `lib/release/filters.ts`：`filterMapPois`（多选 OR + searchOrder 排序）
      与 `shouldRenderPointPoi`（图钉可见性决策树：选中永远显示/搜索+筛选四开关/
      仅筛选 filterable+filter+matched/默认 visibility.default）。设施状态用 release
      快照（poi.facilityOperationalStatus），不接实时接口。
    - `lib/map/markers.ts` 增 `buildVisibleMarkers`（决策树版 buildMarkers，
      无筛选无搜索时结果与 buildMarkers 完全一致，automator 基线不破）。
    - 两个入口共享 `data.activeFilters`：搜索面板「标签筛选」chip 行（横滑 scroll-view，
      toggle 后无 query 时结果列表 = 筛选命中的本校区 POI，filterRows）；图层浮钮
      （右上 44px 圆形）→ 浮卡「高亮类别」chips（onLayerFilterTap，只改筛选不弹面板）。
      chip 选中态预计算进 data.filterChips——**WXML 表达式不支持 indexOf 等函数调用**。
    - 页面侧单一重算入口 `recomputeMarkers()`（matched 集合按 query/筛选两条路算），
      selectAt/clearSelection/runSearch/toggleFilter/switchCampus 都汇到它；
      搜索结果行过滤走 `refreshSearchRows()`，openSearchHit 改用 displayHits
      （currentHits 保持未过滤供 report 计数）。
    - 楼宇 footprint 筛选高亮：`recomputeMarkers()` 从当前搜索/筛选命中中提取楼宇
      `sourceElementId`，通过 `lib/map/svg-highlight.ts` 注入 Web 端 `data-match` 同款样式，
      写入唯一临时 SVG 并叠在底图与运营事件层之间；POI 详情态隐藏，关闭详情后恢复，
      重置筛选、切校区与页面卸载均清理文件。开发者工具的 SVG 解码器会忽略较长的
      末尾选择器规则，命中图形还需同步写 inline style；automator 用筛选前后截图的
      目标楼宇局部像素差验证真实渲染，不能只检查文件和页面状态。
  - 运营事件（2026-08-07 全新导入，对齐 Web 端 M8）：
    - `lib/release/operations.ts`：GET /api/public/operations 的模型子集 +
      `parseOperationsResponse` 严格校验 + `activeOperations`（scheduled/active）+
      `buildEventOverlayItems`/`overlayItemsForCampus`/`overlayAnchor`（Point 原坐标，
      Polygon/LineString 顶点质心）+ 文案（formatEventDateRange「X月X日 - X月X日 /
      起 · 长期」）+ `resolveEventTargetNames`/`eventsTargetingPoi`。几何解析在
      `lib/geoGeometry.ts`（零依赖搬 Web 端）。**事件是 live 数据：页面侧任何一步
      失败都 try/catch 静默降级为不显示**（loadOperations/refreshEventOverlay 两道防线）。
    - 显示：面/线轮廓画进一张透明 SVG 写 USER_DATA_PATH 临时文件，同尺寸同定位
      <image> 盖底图（与楼宇高亮同一招，applyEventOverlayImage；描边随缩放变粗，
      不同于 Web 端屏幕恒定描边）；图钉只给点状「事件位置」出（`eventMarkerItems`
      过滤，区域/路径不再叠质心图钉——轮廓本身整块可点，对齐 Web 端）；
      颜色取 `eventColor(event)`（管理端可自选 color 列，0028；未设置回落 severity
      三色，与 Web 端 MapEventOverlay 同口径）；marker **复用 `.poi-pin` 类吃现有
      applyAnimatedStyle 反向缩放**，新增 marker 不碰手势 worklet 体系。
    - 交互：handleTapAt 命中优先级 **POI 图钉 → 事件锚点 → 事件区域 → 楼宇**（与 Web 端
      「POI 在 overlay 之上」一致；曾把事件放最前，结果宝山「测试」图钉与事件
      锚点相邻时 tap 被事件劫持，automator 4 节直接翻车）→ 点事件出底部摘要卡
      （eventSummary）→「查看详情 ›」事件详情 sheet（z-index 150，
      高于 POI sheet 的 100，可从 POI 横幅上方叠开）；POI 详情 sheet 顶部
      severity 色横幅 = eventsTargetingPoi 命中第一条，点按开事件详情。
    - 图层浮卡「运营事件」开关（eventsOn，默认开）控制 marker+轮廓显隐，
      关掉同时清摘要卡；校区切换只重过滤不重拉（事件 boot 时拉一次）。
    - 单测 `tests/miniprogram-operations.test.mjs`、`tests/miniprogram-map-filters.test.mjs`；
      automator 4.7 节覆盖 overlay 数/筛选图钉数/浮卡 toggle/事件开关/摘要卡/详情 sheet。
  - automator 直调：`performSearch(query)`（不防抖）/`openSearchHit(index)`；
    report 增 `searchQuery/searchHitCount/searchFirstPoiKey/detailOpen/detailPoiKey/detailMerchantId`。
- 楼层图页 `pages/floors/floors`（Skyline，已注册 app.json）：
  - onLoad 收 placeId；楼层 = manifest.floors 按 buildingPlaceId 过滤 + isPublic + levelOrder 升序，
    默认选最小层；**有无平面图看 manifest `floors[].imageUrl`**（楼层级位图，站内相对路径
    `/api/public/media/…`，null = 无图纸强制列表视图）。楼层图不再是 map_versions/SVG，
    `lib/release/floorPlans.ts` 与设施锚点徽章已整体删除。
  - 平面图视图：站内 imageUrl 经 `apiGetBinary` 云托管代理下载后写本地文件，
    `<image>` 读取本地路径；切层/卸载丢弃过期响应并清理文件，失败可重试。
    **捏合缩放与拖动由 movable-area + movable-view（scale，1~5 倍）原生实现**，
    不用 JS 线程手势 + viewport.ts（该方案仅为校区地图保留）。movable-view 高度按
    图片宽高比实测（bindload natural size × 容器宽），竖长图纸 1 倍下也能拖到底部；
    加载中/失败有覆盖层（失败可重试：清 src 再置回强制重拉）。
  - 列表视图：楼层说明（facts 里 label === "楼层说明"）+ 本层实拍（media 里 floorLevelCode 匹配）
    + 本层设施行（poi.facilities 按 floorId 过滤）；设施元数据一律从楼宇 poi.facilities 按 id 回查。
  - automator 直调：`switchFloor(floorId)`/`setView(view)`；
    report：`{placeId, floorCount, activeFloorId, hasPlan, view, planState}`。
- 端到端：`scripts/miniprogram-map-automator.mjs` 5.5 节覆盖搜索→详情 sheet；
  `scripts/miniprogram-floors-automator.mjs` 覆盖楼层图页（node 侧选目标楼宇：
  优先有平面图的，没有则退到有楼层+设施的楼宇断言列表视图）。单测 `tests/miniprogram-search.test.mjs`。
  floors automator 已改为位图路径/文件存在、列表/平面图及切层断言。
- 未验证项：楼层位图化后 plan 视图（movable-view 捏合/拖动手感、imageUrl 直连）未端到端验证
  （Skyline 下 movable-view scale 行为需真机确认）；搜索商户折叠链路线上无商户数据，靠单测覆盖。

## 工程现状（Part 2：地图 canvas 引擎）

- `lib/map/viewport.ts`：视口纯函数，移植 Web 端 `MapCanvas.tsx`（ViewWindow 模型：
  `createInitialWindow`/`clampWindow`/`focusPointWindow`/`zoomWindowAt`/`panWindowBy`/
  `screenToWorld` 等）。手势识别在 JS 线程后直接复用这套纯函数（不再内联）。
- `lib/map/markers.ts`：`buildMarkers`（点 POI 图钉，含 visibility 策略）/
  `buildBuildingShapes`（楼宇 footprint 命中几何，按 sourceElementId 绑 `parseSvgFeatures`
  产物）/`hitTest`（容差内最近图钉优先，嵌套 footprint 取 bbox 最小）。
  **管理端图钉档位（2026-08-23）**：`MapMarker.scale` 来自 manifest——地点/设施/商户
  读 content 的 `marker.size`，校车站点读 `marker_size` 列（0026，站点无 content 通道；
  worker 只在非标准档才把它输出进 manifest，保护旧版客户端的 exactObject 白名单）。
  档位系数小 0.72/标准 1/大 1.35，与 Web 端 src/lib/map/markerTiers.ts 同口径；
  worklet 反向缩放是统一通道给不了 per-marker 系数，所以 `markerPinStyles(scale)`
  把 44/32/22/2 基准换算成四个节点的内联 style（pin 的 left/top/transform-origin
  也要跟着缩放），页面 recomputeMarkers 里挂上。
- `pages/map/map`：地图页。关键做法：
  - **底图用 `<image>` 直连 Worker SVG asset URL**（`/api/public/maps/:id/asset`，
    与 `config.apiBaseUrl` 同源）。Skyline 下网络 SVG 可正常渲染（已截图验证）；
    按 `RASTER_RATIO=3` 放大布局再 `scale(1/3)` 缩回，给高倍缩放留栅格化余量。
  - **手势识别 = `.map-surface` 上的 `bindtouchstart/bindtouchmove/bindtouchend/
    bindtouchcancel/bindtap`（JS 线程）+ viewport.ts 纯函数**（单指 pan、双指 pinch、
    双指抬起一指重新起 pan 防跳变；worklet:ongesture 真机不触发，见坑 #8）。
  - 视口运行时状态是 `wx.worklet.shared` 共享变量（winX/winY/winScale），触摸处理器
    直写（`setWindowDirect`），`applyAnimatedStyle` 驱动 `.map-world` transform；
    图钉反向 `scale(1/s)` 保持屏幕尺寸；逻辑层动画用 `wx.worklet.timing`。
  - **`project.config.json` 的 `compileWorklet` 必须为 true**（Part 2 改的），否则 worklet 不编译。
  - `data.report` 供 automator evaluate 核对（同 debug 页范式）；事件处理器与
    `handleTapAt` 都可被 evaluate 直调——automator 4.5 节用它做 pan/pinch/tap 真端到端模拟。
- `scripts/miniprogram-map-automator.mjs`：端到端回归（装配对比/初始窗口/tap 命中/
  **pan/pinch/tap 触摸事件模拟**（4.5 节）/**楼宇选中高亮覆盖层**（4.6 节，截图
  `tmp/map-test/map-highlight.png` 人工核对）/筛选楼宇轮廓/校区切换/搜索→详情/截图）。跑法同 release-automator：
  `cli auto --project miniprogram --auto-port 9420` 后
  `node scripts/miniprogram-map-automator.mjs`（数据源默认线上 Worker，与页面一致）。
- 单测：`tests/miniprogram-map-viewport.test.mjs`（含移植自 Web 端 map-canvas-point-focus 的用例）、
  `tests/miniprogram-map-markers.test.mjs`。
- 未验证项：触摸事件链路已被 automator 模拟断言覆盖，但真机拖动/捏合手感
  （事件频率、跟手度）仍需真机复测。

## 工程现状（校车部分留下的可复用资产）

- **2026-08-21 校车 0024 改版（校区对校区）**：数据模型从「乘车点点对点」改为「校区 A → 校区 B」，
  预约是线路级属性。`lib/transit/schedule.ts` 对齐 Web 端新版
  `src/lib/transit/schedule.ts`：端点 = campus_id（陈太公寓用 `stop:<stopId>` 伪端点）、
  `fetchCampusLines`（GET /api/public/transit/campus-lines）+ 包内快照兜底
  （`fetchCampusLinesWithFallback`/`loadTransitEndpoints`，快照线路 patterns 为空，
  上下车点 chips 与预览时间线离线态降级不渲染）。快照改为「校区对 → lines[] → 分桶时刻」，
  由 `scripts/generate_miniprogram_shuttle_snapshot.mjs`（主仓库）从 data/shuttle-schedule.json
  生成，预约班次拆独立「（预约）」线，改数据后重跑即可。单测仍 `tests/miniprogram-shuttle.test.mjs`。
  **页面布局用回旧版**（线路卡设计已否决）：校区 OD 选择 + 「最近一班」双 hero
  （预约=required/optional 合并、非预约=not_required，各取剩余首班）+ 时刻网格
  （`flattenLineJourneys` 跨线路摊平 + `mergeSchedulesByTime` 同时刻预/非合并一格）
  + 「上下车点」四行（上车/下车 × 预约/非预约，同类多线按 stopId 合并去重，
  某类无线路则该行不出）+ 班次预览弹层（`buildLinePreview` 本地构建，无二次请求）。

- **2026-08-24 校车预约入口下架**：页头「预约网站 ›」与预览弹层「预约此班次」全部移除，
  `vcard.shu.edu.cn` 也从 webview 白名单摘掉。三条独立死因（详见 `pages/shuttle/shuttle.ts`
  顶部注释）：① 该域名不是我们的，配业务域名要往它根目录传校验文件；② 个人主体配不了
  业务域名，`web-view` 整体不可用；③ `jumpToOrder` 依赖公众号网页授权，小程序 web-view
  不携带该会话。**webview 白名单只能放已配成业务域名的域名**——否则用户卡在微信的
  「不支持打开非业务域名」原生错误页上，`binderror` 未必触发，连本页的复制链接降级都摸不到。
  线路级 `bookingUrl` 在 API / 后台 / Web 端保留不动，只是小程序不再消费。

- **2026-08-24 校车乘坐指南（「如何坐车」）**：入口是**紧贴大标题右侧**的「圆圈问号 + 灰色小字」 →
  `pages/shuttle-guide/shuttle-guide`（默认渲染器 + 原生导航栏，不用 Skyline——本页只是竖排文章）。
  两条视觉约束都踩过坑，`tests/shuttle-ride-guide.test.mjs` 各钉了一条：
  ① **头部不能用 `justify-content: space-between`**——那一行落在微信胶囊按钮（右上角「···」「×」）
  的纵向区间里，任何右对齐元素都会被压在胶囊底下；标题与入口都要 `flex: none` 才不互相挤。
  ② 圆圈用 `border` + `border-radius: 50%` 画、里面放 ASCII `?`，**不用 emoji 问号**：emoji 自带
  彩色，压不成与文字同一个灰。圆圈描边 / 问号 / 文字三者同色（测试比的是色值相等而非写死的
  `#94a3b8`，将来整体调灰度时漏改一处仍会被抓到）。纯灰字曾读起来像说明文字而不是可点的东西，
  图标是那个「这能点」的信号。
  内容**复用 guide_documents**，slug=`shuttle-ride`，公共读端 `GET /api/public/guide/shuttle-ride`，
  与返校指南（`freshman-transit`）共用同一套端点与草稿→送审→发布→回滚流水线，
  所以**零迁移、零新端点**。代价是要满足 guide 模块的 `assertContentShape`：
  `content.cards` / `content.hubs` 必须是数组，乘车指南两个都留空数组。
  内容形状刻意做薄：`meta.title/subtitle` + `blocks[]`（heading / paragraph / list / image 四种块），
  规范化规则在 `lib/shuttle-guide.ts`，与 `shared/shuttle-guide-contract.ts` 手抄同步
  （`tests/shuttle-ride-guide.test.mjs` 对同一批输入比对两份输出，钉住不漂移）。
  入口默认**不显示**：`hasPublishedShuttleGuide()` 探测到有已发布内容且有正文才亮——
  未发布 / 断网 / 空文档都归成 false，点进去看空页比没入口更糟。
  图片走 `kind=figure_png`（PNG/JPEG，服务端按魔术字节嗅探），**不做 `<key>-png` 派生**：
  那是返校指南 SVG 图示的补丁，这份从一开始就是位图入库。
  管理端编辑器：`src/admin/components/ShuttleGuidePanel.tsx`，挂在「校车时刻」页第五个 tab。
  ⚠️ 编辑器里的**未保存草稿只活在组件 state 里**，所以两条防线缺一不可（2026-08-25 修）：
  ① `/api/admin/guide/assets` 必须在 `ADMIN_REFRESH_EXCLUSIONS` 里——`apiFetch` 对任何
  非 GET 的 `/api/admin/` 请求都会广播 `admin-data-changed`，广播会让所有 `useAsyncData`
  回到 loading 态，正在编辑的子树被卸载重挂，刚加的块全没；
  ② 面板自己要留住上一次成功数据（同 `TransitPage` 的 `lastTransit`），因为广播可能由
  **别的**组件的写操作触发，光靠 ① 挡不住。当时的现象是「图片传不上去」，其实字节已进 R2，
  只是引用它的那一块被回滚了。回归钉在 `tests/shuttle-ride-guide.test.mjs`。

- `pages/webview/webview`：通用外链容器（web-view + 复制链接降级），其他页面打开外链直接复用。
  当前白名单只有 `config.webBaseUrl`（本站），暂无调用方
- `lib/api.ts`：API client 封装（`apiGet` JSON / `apiGetText` 原文，后者给 SVG 底图用）；`config.ts`：全局配置
- `data/`：数据快照的 `.ts` 模块范式（离线兜底数据照此办理）
- `typings/shims.d.ts`：TS 声明补丁
- 测试范式：`tests/miniprogram-shuttle.test.mjs`（node 直接跑，纯逻辑单测）。新功能纯逻辑照此添加 `tests/miniprogram-*.test.mjs`
- `app.json` 已有 `componentFramework: glass-easel`；新增页面记得追加到 `pages` 数组

## 工程现状（Part 1：release 数据通路）

- `lib/release/`：从 Web 端搬运的 release 装配纯逻辑
  - `types.ts`（release manifest + 地图模型类型）、`manifestContract.ts`（`parseReleaseManifest` 严格校验）、
    `mapData.ts`（`buildMapPois`/`CAMPUS_DISPLAY`/`campusMapVersions`/`campusConfigFromMap`，网络层已换成 api 通道）、
    `merchants.ts`（floorPlans.ts 已随楼层位图化删除）
  - `loader.ts`：装配入口 `loadReleaseWithCache(deps?)`（deps 可注入 storage/fetcher，单测靠它在 node 里跑）；
    `selectCampus(loaded, campusIdOrKey)` 按 campus id **或** campusKey（baoshan/jiading/yanchang）选校区，
    返回 `{ campus, mapVersionId, viewBox }`（viewBox 由 `parseSvgViewBox` 解析 SVG 原文得到）
  - 依赖：`lib/svg-geometry.ts`、`lib/revision-contract.ts`、`lib/dataContract.ts`
- 缓存约定（wx storage，按 id 作 key 天然失效，无 TTL）：
  `release-current-id`（上次 releaseId 指针）、`release-<releaseId>`（校验过的 manifest JSON）、
  `map-asset-<mapVersionId>`（**校区**底图 SVG 原文）。releaseId 变化清旧 `release-*`；`map-asset-*` 跨 release 复用。
  写入失败（超容量）静默降级为不缓存，见 loader.ts 头注释
- `pages/debug/debug`：Skyline 临时调试页（release 版本/三校区/POI 总数/设施类型），
  装配摘要放在 `data.report` 供 automator evaluate 读取。公测起 profile 页「调试信息」
  入口已移除（2026-08-24），页面仍注册在 app.json，开发期可用 devtools/automator 直开

## 食堂地图概览（2026-09-26）

- 食堂建筑使用 `components/canteen-overview`，在原有字段后显示白底楼层、商户与公共设施；普通建筑保留原组件结构。
- 公开楼层内商户只显示一次；未分层/隐藏楼层的商户在「其他商户」保留。公共设施含楼层位置，详情页按当前层过滤。
- 新组件实时读取安排、商户与设施状态，每 30 秒刷新，隐藏/卸载丢弃旧请求；异步渲染通过 resize 事件触发抽屉高度重测。
- POI 展开时隐藏入校指南横幅，避免 620px 上限抽屉标题被遮挡。
- 细节与验收见 `docs/canteen-overview.md`。

## 工程现状（Part 6：底部 Tab，对齐 Web 端）

- `app.json` 已配 `tabBar` 四个 tab：**地图/校车/就餐/我的**，顺序与文案对齐 Web 端
  `src/components/layout/navTabs.ts`；选中色 `#1e80c1`、普通色 `#94a3b8`。
  `pages/map/map` 是 pages 数组首项（启动直达地图 tab）。
- **自定义 tabBar（`tabBar.custom: true`，2026-08-08 起）**：原生栏约 50px 太矮，
  换成 `custom-tab-bar/` 组件把高度加高到 **64px 内容 + 底部安全区**，视觉对齐 Web 端
  `BottomTabBar.tsx`（白底 96%、顶部 1px `#e8ebef` 边框、4 列均分、图标 26px、
  文字 12px/16px/500——2026-08-10 在 Web 端 22/11/15 基础上上调一档，真机偏小）。`app.json` 里的 `list` 保留作兜底（低版本基础库回退原生栏）。
  - 组件是**纯 JS**（index.js/json/wxml/wxss，不走 TS 编译）；图标用绝对路径
    `/images/tabs/*.png`，active/普通两态直接换 `src`，不做变色。
  - **选中态靠各 tab 页 `onShow` 里 `this.getTabBar()?.setData({ selected: N })` 同步**
    （N = 0..3），自定义栏不会自动高亮；新增 tab 页必须照抄。切换仍走 `wx.switchTab`。
  - 安全区双保险：JS 在 `attached` 里用 `wx.getWindowInfo().safeArea` 算
    `safeBottom`（>0 时 inline `padding-bottom`），算不出则落回 WXSS 的
    `constant()/env(safe-area-inset-bottom)`。**inline style 必须条件输出**——
    无条件渲染 `padding-bottom: 0px` 会把 env() 兜底覆盖掉。
  - `backdrop-filter: blur(12px)` 直接写在 WXSS 里：webview 页（offcampus/profile）
    生效，Skyline 页（map/shuttle）不支持的属性静默忽略、降级为 96% 白底，不报错。
  - 自定义栏是**页面渲染层的一部分**（不再是原生层）：automator 截图能截到，
    验证外观不再需要 macOS `screencapture`。回归脚本
    `scripts/miniprogram-tabs-automator.mjs`（4 个 tab switchTab + 截图到
    `tmp/tab-test/`，直接看截图核对高度/选中态）。
- tab 图标由 `scripts/generate-tab-icons.mjs` 生成（lucide `__iconNode` + sharp →
  81×81 PNG，普通/选中两态），改图标或配色后重跑即可，产物在 `images/tabs/`、`images/menu/`。
- `pages/offcampus/offcampus`：校内就餐 tab；`pages/dining/dining`：食堂楼层与商家详情。
  逻辑在 `lib/dining/`，实时接口与 release 骨架分别加载，规则对齐 PR #7 最终修订。
  图片经云托管下载到本地；隐藏页面停止轮询，跨上海午夜清旧安排。
  `components/feature-feedback` 提供搜索/校车评分入口，打开原生评价页。
  同步核对与验证说明：`docs/miniprogram-pr-sync.md`。
- `pages/profile/profile`：Web ProfilePage 的子集——最近查看（条数，switchTab 回地图）、
  关于 SHUMap；页脚数据版本走 `loadReleaseWithCache().version`。（公测前已移除调试信息入口）
- **tab 页之间/进入 tab 页必须 `wx.switchTab`**（navigateTo 打不开 tab 页）；
  ~~页面视口自动不含 tab 栏高度~~ **纠正（2026-08-07 实证）：`position: fixed; bottom: 0`
  的浮层参照的是含 tab 栏的完整窗口，自定义 tabBar 会盖住底部约 64px+安全区**——
  矮的 bottom sheet/浮卡会被整条遮住（嘉定图书馆详情曾因此“打开了但不可见”）。
  地图页的 sheet-mask / event-card / search-body 已加 `calc(64px + env(safe-area-inset-bottom))` 抬高，
  校车页班次预览 sheet（shuttle.wxss `.sheet`）同样已抬 64px；其他 tab 页新增底部浮层照此办理。
- `scripts/miniprogram-release-automator.mjs`：端到端回归——node 侧跑同一份 loader 打真实后端算期望值，
  再连开发者工具读 debug 页 report 对比。用法：`cli auto --project miniprogram --auto-port 9420` 后
  `SHUMAN_API_BASE=http://localhost:8799 node scripts/miniprogram-release-automator.mjs`
- `tests/fixtures/release-manifest-live.json`：真实 releases/current 快照（strict 校验的 fixture）

## 本地后端数据注意（Part 1 踩到最大的坑）

本地 D1 曾长期只有旧契约边界测试工件（无校区底图、places 缺 kindName/isBuilding），
**驱动不了地图装配**（Web 端也一样，只是优雅降级看不出来）。2026-08-07 已按
「清 `.wrangler/state` → 带 `--var ADMIN_BOOTSTRAP_SECRET:<值>` 起 dev（注意 `--var` 用冒号）
→ migrations + `output/v2-seed.sql` → `wrangler r2 object put` 三张校区 SVG
（`data/campus-map-assets.json` 有 objectKey/sha256）→ bootstrap → `POST /api/admin/releases`
（body 必须含 `mapVersionIds` 数组，三张 `map_version_campus_*`）」重建，8788 现在是健康 release。
本地 admin 账号：`admin@example.com` / `LocalDevPass123!`（仅此本地库，远端另有自己的凭证）。
需要清库重建时按上面顺序重跑即可。

8788 dev 进程当前起法（2026-08-07 重建后）：
`npx wrangler dev --port 8788 --var ADMIN_BOOTSTRAP_SECRET:local-only-bootstrap-secret`，
日志在 `tmp/8788/dev.log`，bootstrap secret 为 `local-only-bootstrap-secret`
（users 表非空后 bootstrap 接口自动关闭，secret 留着也无碍）。

## 通用约束（全项目共识）

- 不要修改 `worker/`、`migrations-v2/`、`src/admin/`
- 手势识别用 JS 线程触摸事件 + `lib/map/viewport.ts` 纯函数（worklet:ongesture 真机不触发，见坑 #8）；渲染驱动仍走 `wx.worklet.shared` + `applyAnimatedStyle`/`wx.worklet.timing`，不要自己再发明一套
- 可搬运的 Web 端纯逻辑：`shared/svg-geometry.mjs`、`shared/revision-contract.ts`、`src/lib/release/`、MapCanvas.tsx 里的视口纯函数（clampWindow/focusPointWindow 等）
- 完成后必须自验：开发者工具编译无报错 + miniprogram-automator evaluate/console 验证，并在总结里说明验证方式
