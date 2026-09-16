import type { Env } from "../types/cloudflare";
import { all } from "../lib/db";
import { HttpError, json, noContent, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { exactObject, isoNow, makeId, numberValue, optionalString, requiredString } from "../lib/values";

const MAX_FEEDBACK_BYTES = 8 * 1024;
const MIN_RATING = 1;
const MAX_RATING = 5;

interface FeatureFeedbackRow {
  id: string;
  page: string;
  rating: number;
  reason: string | null;
  createdAt: string;
}

function assertRating(value: unknown, field: string): number {
  const rating = numberValue(value, field);
  if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
    throw new HttpError(400, "validation_error", `${field} must be an integer between ${MIN_RATING} and ${MAX_RATING}`);
  }
  return rating;
}

/**
 * POST /api/public/feature-feedback — 「你觉得这个功能好用吗」星级评分。
 *
 * 纯运营数据，与内容反馈（content_submissions）分开：不审核、不进发布流，
 * 所以也不需要会话——和 /api/analytics/events 一样匿名即可提交。限流防滥用，
 * 库里的 check 约束兜底格式；低分鼓励附原因只是前端引导，服务端不强求。
 */
export async function submitFeatureFeedback(request: Request, env: Env): Promise<Response> {
  await enforcePublicRateLimit(request, env, "feature-feedback", 30);
  const body = exactObject(
    await readJsonLimited<unknown>(request, MAX_FEEDBACK_BYTES),
    "feedback",
    ["page", "rating"],
    ["reason"],
  );
  const page = requiredString(body.page, "page", 50);
  const rating = assertRating(body.rating, "rating");
  const reason = optionalString(body.reason, "reason", 500);
  await env.DB.prepare(
    `insert into feature_feedback(id,page,rating,reason,created_at) values(?,?,?,?,?)`,
  ).bind(makeId("feature-feedback"), page, rating, reason, isoNow()).run();
  return noContent();
}

/**
 * GET /api/admin/feature-feedback?page=&rating= — 管理端列表，最新在前。
 *
 * 过滤条件是可选的查询参数；不带则返回最近 200 条。rating 传了就必须是
 * 1-5 的整数，否则 400——静默忽略一个写错的过滤条件会让人误以为筛过了。
 */
export async function listFeatureFeedback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  const page = params.get("page");
  if (page) {
    conditions.push("page=?");
    values.push(page);
  }
  const ratingParam = params.get("rating");
  if (ratingParam) {
    conditions.push("rating=?");
    values.push(assertRating(Number(ratingParam), "rating"));
  }

  const where = conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "";
  const items = await all<FeatureFeedbackRow>(
    env.DB,
    `select id,page,rating,reason,created_at as createdAt
       from feature_feedback${where}
      order by created_at desc limit 200`,
    values,
  );
  return json({ items });
}
