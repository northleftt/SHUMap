import type { Env } from "../types/cloudflare";
export const RELEASE_ASSET_RETENTION_DAYS = 30;
export function retainReleaseAssets(env: Env, releaseId: string, now: string) {
  const expires = new Date(Date.parse(now) + RELEASE_ASSET_RETENTION_DAYS * 86400000).toISOString();
  return env.DB.prepare(`insert into release_asset_leases(release_id,expires_at,reason,updated_at) values(?,?,'release transition',?)
    on conflict(release_id) do update set expires_at=max(release_asset_leases.expires_at,excluded.expires_at),updated_at=excluded.updated_at`)
    .bind(releaseId, expires, now);
}
