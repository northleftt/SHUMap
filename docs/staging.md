# Staging（预发）环境

独立的 Cloudflare 环境，用于验证破坏性/数据依赖的变更（典型场景：release manifest
新增字段、旧版小程序解析兼容性、迁移演练），**不碰生产**。数据是生产快照的克隆，
可随时重建。

## 资源清单（2026-09-17 建成）

| 资源 | 生产 | Staging |
| --- | --- | --- |
| Worker | `shumap` | `shumap-staging` |
| 自定义域名 | `map.shutf.com` | `staging.map.shutf.com`（另有 `shumap-staging.shu-tf.workers.dev`） |
| D1 | `shumap-v2` | `shumap-v2-staging`（`8b8986ef-492d-447d-b0cb-4759604697fc`） |
| R2 | `shumap-assets` | `shumap-assets-staging` |
| Queue | `shumap-import` | `shumap-import-staging` |
| 云托管反代 | `shumap-api` | `shumap-api-staging`（2026-09-25 已部署） |

配置在 `wrangler.jsonc` 的 `env.staging`。注意 `secrets` 和 `durable_objects`
**不被 env 继承**，staging 下必须重复声明（wrangler 部署时会警告漏配）。
cron（每天 18:00 UTC 清理隔离区照片）与生产同计划，作用于 staging 自己的库和桶。

两个环境的 secrets 各自独立：`SESSION_PEPPER`（staging 已配独立值，会话与生产
互不通用）、`MINIPROGRAM_PROXY_SECRET`（staging 已配独立值，供 staging 反代用）。

> wrangler 4.95 非交互模式不读 `wrangler.jsonc` 的 `account_id`，所有手写
> wrangler 命令必须前置
> `export CLOUDFLARE_ACCOUNT_ID=400623ade20e6d96cb546c98bcf3e33f`。

## 日常操作

```bash
npm run deploy:staging       # 构建 + 部署 shumap-staging（含自定义域名）
npm run migrations:staging   # 对 shumap-v2-staging 应用 migrations-v2
```

管理端：<https://staging.map.shutf.com/admin>（账号与生产相同——用户表随快照克隆；
staging 的会话独立，需重新登录）。

## 灌数据（克隆生产快照）

staging 库/桶可随时清空重建。完整流程（全部只读生产、只写 staging）：

```bash
export CLOUDFLARE_ACCOUNT_ID=400623ade20e6d96cb546c98bcf3e33f
mkdir -p tmp/staging

# 1. D1：导出生产 → 改写 → 导入 staging
npx wrangler d1 export shumap-v2 --remote --output tmp/staging/prod-dump.sql
node scripts/prepare_staging_dump.mjs tmp/staging/prod-dump.sql tmp/staging/prod-dump-fixed.sql
npx wrangler d1 execute shumap-v2-staging --remote --file=tmp/staging/prod-dump-fixed.sql --yes
npm run migrations:staging   # 补齐快照之后新增的迁移（d1_migrations 随快照克隆，通常无新增）

# 2. R2：从 dump 提取对象键清单（media_assets + release artifacts），逐 key 拷贝
grep 'INSERT INTO "media_assets"' tmp/staging/prod-dump.sql \
  | sed -E "s/^INSERT INTO \"media_assets\" \([^)]*\) VALUES\('[^']*','[^']*','(([^']|'')*)'.*/\1/" \
  | sort -u > tmp/staging/r2-keys.txt
grep 'INSERT INTO "releases"' tmp/staging/prod-dump.sql \
  | grep -oE "'release/artifacts/[^']*'" | tr -d "'" | sort -u >> tmp/staging/r2-keys.txt
bash scripts/copy_r2_to_staging.sh tmp/staging/r2-keys.txt
```

`prepare_staging_dump.mjs` 与 `copy_r2_to_staging.sh` 的坑（D1 单行 60KB 上限、
FK 即时强制、wrangler --pipe 横幅污染）分别写在两个脚本的头部注释里。

验证（应与下方「建成时的验证结果」同形态）：

```bash
curl https://staging.map.shutf.com/api/health
curl https://staging.map.shutf.com/api/public/releases/current
```

## 小程序切到 staging

`config.ts` 在模块加载时读 wx storage 键 `shumap.env` 并覆盖
`apiBaseUrl` / `webBaseUrl` / `cloudService`（逻辑在 `lib/env.ts`，
单测 `tests/miniprogram-env-switch.test.mjs`）：

1. 开发者工具里直开 `pages/debug/debug`（编译模式 → 启动页面填
   `pages/debug/debug`，或已编译后从页面路径进入）；
2. 顶部「运行环境」点 **Staging（预发）** → 确认后自动清 release/底图缓存并重启；
3. 切回生产同理。storage 里任何非 `staging` 的值都按生产处理，现网用户不受影响。

真机/体验版要走云托管反代（workers.dev 被墙，自定义域名也不进小程序白名单）。
staging 有独立的反代服务源码 `miniprogram/cloudrun/shumap-api-staging/`
（`server.mjs` 与生产反代逐字节一致，仅 Dockerfile 默认上游不同，
漂移门禁 `tests/miniprogram-cloudrun-staging-proxy.test.mjs`）。部署：

```bash
# CloudBase CLI 凭据会过期，需先人工重新登录（浏览器授权）：
cd tmp/cloudbase-cli && npx cloudbase login --flow device
printf '\n\n' | npx cloudbase cloudrun deploy -s shumap-api-staging --port 80 \
  --source "$OLDPWD/miniprogram/cloudrun/shumap-api-staging" --wait --force \
  -e cloudbase-d1gse9nsp7630b4e7
# 再到控制台给 shumap-api-staging 配环境变量 PROXY_SHARED_SECRET
# （值 = staging worker 的 MINIPROGRAM_PROXY_SECRET），保存触发滚动重启即可。
```

**状态（2026-09-25）**：`shumap-api-staging` 已部署上线（CloudBase CLI 3.8.4，
服务域名 `https://shumap-api-staging-4227820-1465143788.ap-shanghai.run.tcloudbase.com`，
`/healthz` 回指 `staging.map.shutf.com`，release/底图经代理全链路 200）。
开发者工具保持 `useCloudContainer: true` 即可测 staging（云通道会打到
`shumap-api-staging` 服务）。**唯一未做的手工步骤**：控制台给
`shumap-api-staging` 配环境变量 `PROXY_SHARED_SECRET`（值 = staging worker 的
`MINIPROGRAM_PROXY_SECRET`，CLI 无此参数只能控制台配）——未配时小程序端
公共限流退回按容器出口 IP 合计，功能正常，仅限流粒度变粗（与生产反代
2026-08-25 之前的状态相同）。若反代暂时不可用，在 devtools 里把
`useCloudContainer` 临时改为 `false` 也可直连 `staging.map.shutf.com` 测试。

## 哪些操作只能在 staging 做

- 破坏性/不兼容的 manifest 变更（如 `floors[].imageUrl` 这类旧客户端解析不了
  的字段）发 release 验证；
- 迁移脚本的破坏性演练（删列、改约束、数据回填）；
- 清空重建整库整桶；
- cron 清理逻辑、导入队列的端到端演练。

铁律不变：staging 的任何脚本都不得写生产资源；生产只读导出允许。
