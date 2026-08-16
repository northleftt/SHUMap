# SHUMap

SHUMap 是上海大学校园地图与校园服务数据系统。前端使用 React、TypeScript 与 Vite，后端运行在 Cloudflare Workers，持久化层由 D1 与 R2 组成。

## 数据模型

当前数据统一使用 v2 架构：

- `map_filter_categories` 保存地图筛选 chip。
- `map_filter_members` 保存 chip 下的地点类型、设施类型或商户成员；一个成员只能归入一个 chip。
- `place_kinds` 与 `places.kind_id` 保存地点分类。
- `facility_types` 与 `facility_instances.facility_type_id` 保存设施分类和实例。
- `place_revisions`、`facility_revisions`、`merchant_revisions` 保存完整内容与结构修订。
- `map_features` 保存 SVG 元素解析结果，`location_anchors` 通过 `map_version_id` 和 `map_feature_id` 绑定地图要素。
- `entity_locations` 负责地点、设施、商户、运营事件与交通站点的位置关联。
- D1 的 active release 记录是唯一发布指针；R2 保存不可变发布产物和地图资产。

`migrations-v2/0012_map_filter_integrity.sql` 在数据库层维持分类完整性。使用中的地点类型、设施类型和商户成员必须归入启用中的 chip。

## 本地开发

```bash
npm install
npm run dev
```

常用验证命令：

```bash
npm run typecheck
npm test
npm run build
```

本地应用 D1 迁移：

```bash
npm run db:migrate:local
```

生成可重复执行的 v2 种子 SQL：

```bash
npm run db:seed:v2
```

`output/` 属于本地生成目录，不进入版本控制。

`data/campus-map-assets.json` 是迁移内三张校区底图的正式资产清单。迁移生成器、R2 同步命令和发布校验共同使用其中的对象键、字节数与 SHA-256。先在本地校验源文件：

```bash
npm run maps:verify:canonical
```

完成数据库迁移前，将清单中的对象显式写入远程 R2：

```bash
npm run maps:upload:canonical
```

上传命令会在调用 Wrangler 前重新校验三个源文件，目标固定为 `shumap-assets/maps/campus/*.svg`。发布协调器还会逐个读取所选地图对象，核对 `media_assets.byte_size` 与 `sha256`；对象缺失或内容不一致时，release 保持 `validation_failed`。

## Cloudflare 资源

`wrangler.jsonc` 声明以下绑定：

- `DB`：D1 数据库
- `SHUMAP_BUCKET`：R2 发布与媒体存储
- `IMPORT_QUEUE`：地图导入队列
- `RELEASE_COORDINATOR`：发布协调 Durable Object
- `ASSETS`：前端构建产物

生产入口是 `https://map.shutf.com`（Workers Custom Domain，zone `shutf.com`）。发布前需要设置 `SESSION_PEPPER`。管理员初始化密钥按部署环境单独配置。

## 目录

```text
SHUMap/
├── migrations-v2/          D1 v2 迁移
├── scripts/                种子生成、校验和辅助脚本
├── shared/                 前后端共享契约
├── src/                    React 前端与管理后台
├── tests/                  Node 与 SQLite 集成测试
├── worker/                 Cloudflare Worker v2
└── 地图/                   校园 SVG 源文件
```

主要入口：

- `src/App.tsx`：前端路由
- `src/lib/release/mapData.ts`：发布地图数据解析
- `worker/index-v2.ts`：Worker 路由
- `scripts/generate_v2_seed.mjs`：统一种子生成器
- `scripts/validate_v2_schema.mjs`：架构约束检查

## 数据变更原则

- 内容编辑通过修订、审核和发布链路生效。
- 地图筛选来源只接受统一成员表。
- 地图图形关联只接受 map feature 与 location anchor 链路。
- 持久化 JSON 结构错误会直接中止请求或发布。
- 发布产物具有大小上限，并通过流式 R2 读写处理。
