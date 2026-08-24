import type { Env } from "../types/cloudflare";
import { first } from "./db";
import { HttpError } from "./http";
import { isoNow, sha256 } from "./values";

const WINDOW_MS = 10 * 60 * 1000;

/**
 * 按 openid 细分桶时，同一出口 IP 仍套一个粗桶，额度是细桶的这个倍数。
 *
 * 存在理由见下方 rateLimitSubject 的注释：`x-shumap-openid` 不是可信身份，而容器实测
 * 在「公网默认域名已关闭」的状态下仍可从公网直连，所以这不是一层可以省掉的防御。
 * 粗桶让「伪造并轮换 openid」最多把额度放大到这个倍数，而不是无上限；同时倍数要够大，
 * 不能把正常的全校小程序流量卡住——反馈 20→500 次/10 分钟、
 * 照片上传 30→750 次/10 分钟，都远超真实用量。
 */
const AGGREGATE_MULTIPLIER = 25;

/** 长度无关的逐字节比较，避免用 `===` 比密钥时泄露前缀信息。 */
function secretEquals(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.byteLength ^ b.byteLength;
  const length = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
}

/**
 * 限流主体：能认出「同一个人」就按人算，否则退回 IP。
 *
 * 小程序的请求全部经微信云托管代理转发（miniprogram/cloudrun/shumap-api），
 * 于是所有小程序用户在 Worker 看来共用容器出口那一个 `cf-connecting-ip`——
 * 按 IP 计数会把全体小程序用户塞进同一个桶，`submission-create` 的 20 次/10 分钟
 * 会被整体用光，之后**所有人**提交反馈都拿 429（Web 端各自独立 IP，不受影响，
 * 所以这个故障看起来像「小程序不能提交」）。
 *
 * 云托管在用户态调用时注入 `x-wx-openid`，代理把它连同共享口令重新签发成
 * `x-shumap-openid` / `x-shumap-proxy-secret`，这里凭口令决定是否采信；采信即一人一桶，
 * 与 Web 端按 IP 的粒度对等。口令未配置或不匹配就退回按 IP，即退回修复前的行为。
 *
 * **口令只证明「请求确实经过我们的代理」，不证明「openid 是网关注入的真身份」。**
 * 代理分辨不出 `x-wx-openid` 是微信网关注入的还是调用方自填的——它剥掉的是客户端自带的
 * `x-shumap-*`，管不了 `x-wx-openid`，于是会照样用真口令签发出去。
 *
 * 直觉上「关掉容器的公网访问」就能补上这个缺口，但 2026-08-25 实测**并没有**：控制台
 * 已显示「公网默认域名：关闭」、API 读到的 `AccessTypes` 与 `DefaultDomainName` 均为空，
 * 而绕开本机代理、直接连腾讯 ingress 的真实地址（124.223.146.85 / 124.223.145.112）
 * 并带上容器域名的 Host 头，`/healthz` 仍然回 200 —— 关闭开关并没有真的收掉入口。
 * 所以**不要把「公网已关」当成安全前提**，它既不由本仓库保证，实测也不成立。
 *
 * 因此 openid 分桶只当作「让正常用户互不挤占」的优化，不当作可信身份；真正兜住滥用的是
 * enforcePublicRateLimit 里按出口 IP 的粗桶：轮换 openid 最多把额度放大
 * AGGREGATE_MULTIPLIER 倍，不会变成无限。
 *
 * openid 只当标识符用，不落库明文——和 IP 一样先拼 scope 再 sha256。
 */
function rateLimitSubject(request: Request, env: Env): string {
  const expected = env.MINIPROGRAM_PROXY_SECRET;
  const presented = request.headers.get("x-shumap-proxy-secret");
  const openId = request.headers.get("x-shumap-openid");
  if (
    expected !== undefined
    && expected !== ""
    && presented !== null
    && secretEquals(presented, expected)
    && openId !== null
    && openId !== ""
  ) {
    return `openid:${openId}`;
  }
  return `ip:${clientAddress(request)}`;
}

/** 计数 +1 并在越限时抛 429。同一请求可能要过两个桶（细桶 + 粗桶）。 */
async function bumpAndCheck(env: Env, key: string, limit: number): Promise<void> {
  const now = isoNow();
  const resetBefore = new Date(Date.now() - WINDOW_MS).toISOString();

  await env.DB.prepare(
    `insert into public_rate_limits(key,request_count,window_started_at,updated_at)
     values(?,1,?,?)
     on conflict(key) do update set
       request_count=case when public_rate_limits.window_started_at<=? then 1 else public_rate_limits.request_count+1 end,
       window_started_at=case when public_rate_limits.window_started_at<=? then excluded.window_started_at else public_rate_limits.window_started_at end,
       updated_at=excluded.updated_at`,
  ).bind(key, now, now, resetBefore, resetBefore).run();

  const row = await first<{ requestCount: number }>(
    env.DB,
    "select request_count as requestCount from public_rate_limits where key=?",
    [key],
  );
  if ((row?.requestCount ?? 0) > limit) {
    throw new HttpError(429, "rate_limited", "Too many requests; please try again later");
  }
}

/**
 * 两层限流：细桶按主体（可信 openid 则按人，否则按 IP），粗桶按出口 IP 兜底。
 *
 * 只有走 openid 细桶时才加粗桶——按 IP 计数时细桶本身就是 IP 粒度，再加一个
 * 同 IP 的粗桶只是重复计数。
 */
export async function enforcePublicRateLimit(
  request: Request,
  env: Env,
  scope: string,
  limit: number,
): Promise<void> {
  const subject = rateLimitSubject(request, env);
  await bumpAndCheck(env, await sha256(`${scope}:${subject}`), limit);
  if (subject.startsWith("openid:")) {
    await bumpAndCheck(
      env,
      await sha256(`${scope}:aggregate:ip:${clientAddress(request)}`),
      limit * AGGREGATE_MULTIPLIER,
    );
  }
}
