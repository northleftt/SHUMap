import type { Env } from "../types/cloudflare";
import { first } from "./db";
import { HttpError } from "./http";
import { isoNow, sha256 } from "./values";

const WINDOW_MS = 10 * 60 * 1000;

export async function enforcePublicRateLimit(
  request: Request,
  env: Env,
  scope: string,
  limit: number,
): Promise<void> {
  const address = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
  const key = await sha256(`${scope}:${address}`);
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
