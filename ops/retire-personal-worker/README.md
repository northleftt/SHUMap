# 下线个人号旧 Worker

**状态：已于 2026-08-15 下线。** 当前版本 `8954a1b5-63b4-481c-8f89-cdcc8dfff7e6`，
`shumap.wangyixuan163.workers.dev` 全路径回 410，正式站未受影响。
本文档保留下来，是因为下面两个坑在再次操作这个账号时还会踩到。

个人号 `shumap.wangyixuan163.workers.dev` 在迁到公共账号后只作封存入口，
但它下线前跑的仍是完整应用，并且绑着**个人号那份旧 D1**
（`61c93320-b731-44a0-a5a6-fc32177dba42`，正式站是 `7b36d7cb-…`）。
旧编辑器还能从那儿登录并写入旧库，这就是「第 7 版在正式站，个人号只看到第 6 版」的来源。

这里的 `offline.ts` 把它换成 410 下线页：页面指向 `map.shutf.com`，`/api/*` 回 JSON 410。
D1 / R2 / Assets 绑定都摘了；DO 与 Queue 两个绑定**留着不是疏漏**，原因见下面两节。

## ⚠️ 先看这条，不然会误删线上

仓库根 `wrangler.jsonc` 写死了 `account_id = 400623ade20e6d96cb546c98bcf3e33f`
（公共号 = 正式站）。**这个字段优先级高于 `CLOUDFLARE_ACCOUNT_ID` 环境变量。**
已实测：在根目录 `export CLOUDFLARE_ACCOUNT_ID=312d…` 再跑 wrangler，
请求依然打到 `/accounts/400623…/`。

两个账号里 Worker 同名都叫 `shumap`，所以在根目录跑
`wrangler delete --name shumap` 删的是**正式站**，不是封存站。

必须显式 `-c` 指到本目录这份配置：

```sh
# 先确认打的是个人号（应看到 env.DB = 61c93320-…，不是 7b36d7cb-…）
npx wrangler versions view <version-id> -c ops/retire-personal-worker/wrangler.jsonc

# 空跑
npx wrangler deploy -c ops/retire-personal-worker/wrangler.jsonc --dry-run

# 真发（会覆盖个人号 shumap 的现网部署）
npx wrangler deploy -c ops/retire-personal-worker/wrangler.jsonc
```

发完自检：

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://shumap.wangyixuan163.workers.dev/          # 410
curl -s -o /dev/null -w '%{http_code}\n' https://shumap.wangyixuan163.workers.dev/api/public/guide  # 410
curl -s -o /dev/null -w '%{http_code}\n' https://map.shutf.com/                              # 200，必须没被动到
```

## ⚠️ 第二个坑：必须继续导出 ReleaseCoordinator

第一次发版被 Cloudflare 拒了：

```
New version of script does not export class 'ReleaseCoordinator' which is
depended on by existing Durable Objects. [code: 10064]
```

个人号上已经存在 `ReleaseCoordinator` 的 DO 命名空间，新上传的脚本**必须继续导出同名类**，
否则拒绝上传。所以 `offline.ts` 里留了一个只回 410 的空壳类，`wrangler.jsonc` 里保留
`durable_objects` 绑定，`migrations` 的 tag 与根配置**完全一致**（`v2-release-coordinator`）——
该 tag 在这个账号上早就应用过，照抄即为 no-op，不会重建命名空间。

空壳不会丢数据：原实现从不用 `state.storage`（发布数据全在 D1 与 R2，整个 worker 里搜不到
`state.storage`），DO 实例本身没有需要保留的持久状态。

不要改成 `deleted_classes` 迁移——删类**不可逆**，封存期没这个必要。

## ⚠️ 第三个坑：还得导出 queue 处理器

清掉 DO 那条之后，第二次发版又被拒：

```
Queue handler is missing. [code: 11001]
```

这个脚本在个人号上仍注册着 `shumap-import` 队列的 **consumer**，所以新版本必须导出
`queue` 处理器。注意 consumer 是队列侧的注册，光从 `wrangler.jsonc` 里删掉 `queues`
配置并不会解除它，`versions view` 里能看到 `Handlers: fetch, queue`。

`offline.ts` 里的 `queue()` 只打一行日志再 `ackAll()`。不用 `retryAll()`：下线后没有
处理逻辑，重试只会让残留消息一直转到超出上限，既不会被处理，也更难看出发生过什么。

## 为什么不是 `wrangler delete`

`delete` 会一并回收 workers.dev 子域，旧链接变 NXDOMAIN，看不出「搬去哪了」。
410 + 跳转说明保留了引导。真要彻底删，等这个下线页挂过一阵、确认没人再访问后再说，
并且同样要带 `-c`。个人号那份旧 D1 `61c93320-…` 本次不动，留作数据封存。
