# 客户端契约：长期支持与发布流程

这是长期机制，适用于小程序审核延迟、仍在运行的旧包和旧网页。发布契约之后固定其含义，不随服务端“最新版本”隐式改变。应用版本、内容 releaseId、API contract 是三个独立维度。

## 当前协议

| 请求 | 协议 | 能力 |
| --- | --- | --- |
| 无 `contract`，或 `contract=legacy` | legacy | schemaVersion=2，旧楼层结构，位图退回设施列表 |
| `contract=map-2026-09` | map-2026-09 | 同一内容发布，增加 floors[].imageUrl |

覆盖 `/api/public/releases/current`、`/api/public/releases/:id` 、`/api/public/places/:id` 和 `/api/public/transit/campus-lines`。`GET /api/public/contracts` 公布默认、推荐与生命周期。校车legacy保留服务日历日型标签，新契约使用校园校历；班次查询一致。新增独立就餐接口不改变旧路径；其他既有API继续保持原返回结构，不根据应用版本猜测能力。

Worker 注册表与投影在 `worker/lib/client-contracts.ts`。manifest 每一层严格对象通过固定字段白名单输出；内嵌 content 仍使用原有JSON扩展字段。schemaVersion=2不变，legacy所需indoorSpaceId等键保留。canonical 数据不受投影修改，内部发布、搜索和资产权限读取原始数据。

未知/空/重复contract返回400 `unsupported_client_contract`；已退役契约返回410 `client_contract_retired`，不会偷偷升级响应。成功响应带`x-shumap-contract`和生命周期头。deprecated可附Sunset，日期本身不会触发自动停用。

Web使用 `shared/client-contracts/client.ts`，小程序镜像 `lib/client-contract.ts`，一致性测试防止漂移。小程序两种网络通道都通过 release loader 的 query 传递契约；云托管代理原样转发 URL。

## 缓存与资产

- URL含contract，边缘/浏览器缓存自然分离。ETag与content-length按实际投影字节计算，304仅匹配同一表示。
- manifest缓存包含环境、契约和releaseId；map缓存同样隔离。旧缓存不会误用为新版本；不自动删旧包缓存，方便回滚。
- 内容发布和回滚时，上一版获得30天地图资产读取租约。只允许active、或拥有未过期租约的superseded release成员，仍需媒体获准公开读取。失败、未发布、过期或被撤销资产均拒绝。
- 租约管的是旧内容资源，不是客户端支持寿命。legacy客户端每次仍读取最新内容的兼容投影，支持legacy不会自动永久保留所有历史图纸。
- 紧急撤销媒体后即使租约有效也拒绝服务；已缓存资产受既有缓存TTL约束。修改/删除旧资产前先检查租约，必要时延期。

运维命令（需已配置CLOUDFLARE_ACCOUNT_ID）：

```
node scripts/release-asset-lease.mjs list staging
node scripts/release-asset-lease.mjs grant staging RELEASE_ID 30 '旧客户端观察期延长'
node scripts/release-asset-lease.mjs revoke staging RELEASE_ID
```

prod使用同样命令，将环境参数改为prod。grant只接受已发布记录，最长90天，可明确续期；revoke立即撤销服务端读取资格。

## 以后如何更新

1. 文案/UI修复、已有字段值更新：保留contract。应用包版本正常递增。
2. 新字段/字段移除/类型或枚举语义破坏旧解析：新增契约与独立投影，不改已发布契约白名单。先添加历史解析器回放与新旧响应测试，再先部署后端。
3. 新Web和小程序显式升级常量，确认缓存隔离；小程序按新契约提审。
4. 审核通过再发布客户端；旧端持续使用旧契约。避免按App版本区间散落分支。
5. 退役：先标deprecated、公布successor与计划，至少观察两个完整发布周期且连续30天无已知有效旧端流量，并确认产品支持窗口。Worker `client_contract_read`结构化日志用于观察，但缓存命中不会回源，不能单凭零日志判定零用户。
6. 决定停止支持后显式标retired并保留410墓碑；无参数仍映射legacy，永不重解释成最新。保留历史测试，避免未来误复活。若要撤销本次升级，先回滚客户端常量/Worker版本，保持迁移表不删，之后再清理无引用代码和资产。

## 审核与首次生产发布

首次需要后端兼容服务提前就绪，审核版才可用生产新接口。审核版和正式版使用相同生产服务及行为；不按审核身份切换。

1. staging迁移0037并部署完整新版，用历史解析器、新Web、新小程序回归。
2. 冻结生产旧网页字节快照，再应用0035/0036/0037增量迁移；迁移只加表，已应用0032–0034不重跑。
3. 使用backend-only命令部署新版Worker和**捕获的现网页资产**，不发布新内容release，逐文件核对原网页不变。
4. 新包从干净storage确认默认prod、contract=map-2026-09，冻结源码commit/AppID/应用版本后上传审核。当前契约客户端是新的发布候选，上一轮未携带契约的包不可用作最终审核包。
5. 审核通过后执行正常Web build/deploy并发布小程序。新内容快照仍可独立发布，旧端自动获得legacy投影。

```
node scripts/deploy-backend-preserve-web.mjs capture prod tmp/rollout/web-before
CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy-backend-preserve-web.mjs deploy prod tmp/rollout/web-before
node scripts/deploy-backend-preserve-web.mjs verify prod tmp/rollout/web-before
```

capture保存首页、递归发现的assets依赖和仓库public清单对应的远端字节；拒绝外域跳转/伪装成静态资产的SPA兜底。应用若新增动态资源路径，部署前必须扩充清单。snapshot含哈希，无凭证；部署前拒绝被修改快照或已变化的远端首页。上传范围只取snapshot/assets目录。

回滚：使用记录的旧Worker版本回滚；新表可保留。若已经发布新契约客户端，禁止回退到完全不懂该契约的后端，应该回滚到上一份兼容版本。不得以重置整库作为常规回滚。

## 验证边界

历史fixture固定自PR2前提交 `fdd7931^1` 的原解析器，旧生产、新staging、legacy投影和新客户端均回放。线上微信当前包的准确源码commit仍需与发布记录核对；兼容承诺以受支持契约/历史fixtures为准，不能把任意未知旧包都视作已测。

校历0035种子截至2026-09-13，首次启用新版日型服务前必须核对当前学年/节假日运营数据；不可从本地测试安排复制到生产。

## 本次验证

747项测试、Web/Worker类型检查、生产构建通过。历史Web/小程序原解析器均可读取legacy投影；真实旧生产Web资源连接新staging后端通过。新Web/小程序显式契约和缓存隔离通过，staging独立后端部署前后35个资源哈希一致。
