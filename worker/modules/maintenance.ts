// 定时维护任务。目前只有一项：隔离区照片清理（scheduled handler 调用）。
//
// 背景：POST /api/public/media 的照片一律落 quarantine/submissions/，只有随反馈
// 被采纳才会搬去 public/media/。未被采纳的照片（提交被驳回、部分采纳、或用户
// 上传后从未提交）此前没有任何清理路径，R2 里会无限堆积。防滥用只有 IP 限速，
// 所以这里按保留期兜底删除。
//
// 边界与原则：
//   * 只删 bucket_scope='quarantine' 且 status='quarantined' 的行——已搬进
//     public/ 的（status='published'）与已被审核标 rejected 的行不在清理范围；
//   * 挂在**未决**反馈（pending / in_review）上的照片不删：审核人还要看图；
//   * 已决反馈上未采纳的照片：R2 对象删除，media_assets 行改 status='deleted'
//     留作墓碑（submission_media 对它是 on delete restrict，删行会撞外键；
//     审核界面对已决反馈显示「图已清理」比显示一行凭空消失的记录更诚实）；
//   * 未挂任何反馈的孤儿上传：R2 对象删除 + 行直接删除（无外键引用）。
//   * 每次运行条数封顶，保证 cron 在 CPU 限额内完成；积压多时第二天继续。

import type { Env } from "../types/cloudflare";
import { all } from "../lib/db";

const QUARANTINE_PREFIX = "quarantine/submissions/";
/** 隔离区照片保留期（天）。审核积压一般以天计，30 天足够宽裕。 */
export const QUARANTINE_RETENTION_DAYS = 30;
/** 单次运行最多处理的行数。 */
const MAX_PER_RUN = 300;

interface QuarantineRow {
  id: string;
  objectKey: string;
}

/**
 * 从查询行分类出本次应执行的动作。独立成纯函数是为了可测：判定逻辑
 * （保留期、未决保护、墓碑 vs 删行）比 SQL 本身更容易写错。
 */
export function classifyQuarantineRows(
  rows: Array<{ id: string; objectKey: string; createdAt: string; submissionStatuses: string[] }>,
  now: Date,
  retentionDays = QUARANTINE_RETENTION_DAYS,
): { tombstone: QuarantineRow[]; delete: QuarantineRow[]; protectedRows: number } {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const tombstone: QuarantineRow[] = [];
  const purge: QuarantineRow[] = [];
  let protectedRows = 0;
  for (const row of rows) {
    if (row.createdAt >= cutoff) continue;
    if (!row.objectKey.startsWith(QUARANTINE_PREFIX)) continue;
    if (row.submissionStatuses.some((status) => status === "pending" || status === "in_review")) {
      protectedRows += 1;
      continue;
    }
    (row.submissionStatuses.length > 0 ? tombstone : purge).push({ id: row.id, objectKey: row.objectKey });
  }
  return { tombstone: tombstone.slice(0, MAX_PER_RUN), delete: purge.slice(0, MAX_PER_RUN), protectedRows };
}

/** scheduled 入口。吞掉一切错误只打日志（见 index-v2.ts 的注释）。 */
export async function purgeQuarantineMedia(env: Env): Promise<void> {
  try {
    // group_concat 的分组里空集是 null 而不是空串，coalesce 归一。
    const rows = await all<{ id: string; objectKey: string; createdAt: string; submissionStatuses: string | null }>(
      env.DB,
      `select ma.id,ma.object_key as objectKey,ma.created_at as createdAt,
              (select group_concat(s.status) from submission_media sm
                 join content_submissions s on s.id=sm.submission_id
                where sm.media_asset_id=ma.id) as submissionStatuses
         from media_assets ma
        where ma.bucket_scope='quarantine' and ma.status='quarantined' and ma.created_at < ?`,
      [new Date(Date.now() - QUARANTINE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()],
    );
    const plan = classifyQuarantineRows(
      rows.map((row) => ({
        id: row.id,
        objectKey: row.objectKey,
        createdAt: row.createdAt,
        submissionStatuses: row.submissionStatuses ? row.submissionStatuses.split(",") : [],
      })),
      new Date(),
    );

    const r2Keys = [...plan.tombstone, ...plan.delete].map((row) => row.objectKey);
    for (const key of r2Keys) {
      await env.SHUMAP_BUCKET.delete(key);
    }
    const statements = [];
    for (const row of plan.tombstone) {
      statements.push(
        env.DB.prepare("update media_assets set status='deleted' where id=? and status='quarantined'").bind(row.id),
      );
    }
    for (const row of plan.delete) {
      statements.push(env.DB.prepare("delete from media_assets where id=? and status='quarantined'").bind(row.id));
    }
    if (statements.length > 0) await env.DB.batch(statements);
    console.log(
      `quarantine purge: ${plan.tombstone.length} tombstoned, ${plan.delete.length} deleted, `
        + `${plan.protectedRows} kept (attached to undecided submissions)`,
    );
  } catch (error) {
    console.error("quarantine purge failed", error);
  }
}
