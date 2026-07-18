import type { Env } from "../types/cloudflare";
import { first } from "../lib/db";
import { HttpError } from "../lib/http";

const PUBLIC_MEDIA_PREFIX = "public/media/";

export async function getPublicMedia(env: Env, mediaId: string): Promise<Response> {
  const asset = await first<{ object_key: string; content_type: string; sha256: string; status: string }>(
    env.DB,
    "select object_key,content_type,sha256,status from media_assets where id=? and bucket_scope='public'",
    [mediaId],
  );
  if (!asset || asset.status !== "published" || !asset.object_key.startsWith(PUBLIC_MEDIA_PREFIX)) {
    throw new HttpError(404, "not_found", "Media asset does not exist");
  }
  const object = await env.SHUMAP_BUCKET.get(asset.object_key);
  if (!object) throw new HttpError(404, "not_found", "Media object is missing");
  const safeType = allowedPublicContentType(asset.content_type);
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": safeType,
      "content-disposition": "inline",
      "cache-control": "public, max-age=31536000, immutable",
      "etag": `"${asset.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function allowedPublicContentType(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
    case "image/avif":
      return contentType.toLowerCase();
    default:
      return "application/octet-stream";
  }
}
