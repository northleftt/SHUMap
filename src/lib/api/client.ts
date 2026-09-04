// Shared v2 API client. All requests use cookie-session auth (credentials: "include");
// no Bearer tokens, no localStorage. The Worker returns errors as
// { error: { code, message, details? } } — ApiError mirrors that envelope.

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /**
     * Parsed response body, when the server sent JSON. Some endpoints answer with a
     * domain payload instead of the `{ error }` envelope (e.g. the release coordinator
     * returns `{ id, status, validation }` with 422) — callers read it from here.
     */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** No public release is active (503 release_unavailable). Callers render an explicit empty state. */
  get isReleaseUnavailable(): boolean {
    return this.status === 503 && this.code === "release_unavailable";
  }

  /** Session missing/expired (401). Admin surfaces should redirect to login. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

interface RequestOptions {
  method?: string;
  /** Parsed and JSON-encoded automatically; sets content-type. */
  body?: unknown;
  /** Raw body for binary uploads (ArrayBuffer/Blob); caller sets contentType. */
  rawBody?: BodyInit;
  contentType?: string;
  query?: Record<string, string | number | null | undefined>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const ADMIN_DATA_CHANGED_EVENT = "shumap:admin-data-changed";
let pendingAdminChange = false;
/*
 * 这些路径的写操作不广播 admin-data-changed。
 *
 * 判据是「它只往对象存储塞字节，不改任何列表页读到的数据」。广播会让所有
 * useAsyncData 重新拉数据、期间回到 loading 态，于是正在编辑的组件被卸载重挂，
 * 未保存的本地草稿全部丢失。
 *
 * guide/assets 是 2026-08-25 补进来的：上传乘车指南插图时，广播把 ShuttleGuidePanel
 * 整个重挂，刚加的图片块（连同其他没保存的块）一起消失 —— 表现为「图片传不上去」，
 * 其实字节已经进了 R2，只是引用它的那一块被回滚掉了。
 *
 * facility-icons 同理：上传自定义设施图标发生在「新增设施类型」表单里，广播会把
 * 正在填的名称 / 编码 / 筛选按钮名一起清空。图标行本身由界面在上传成功后自行补进
 * 本地列表（不依赖重新拉数据），所以排除掉不会让新图标显示不出来。
 */
const ADMIN_REFRESH_EXCLUSIONS = [
  /^\/api\/admin\/media(?:\/|$)/,
  /^\/api\/admin\/maps\/upload-intents(?:\/|$)/,
  /^\/api\/admin\/maps\/import-jobs(?:\/|$)/,
  /^\/api\/admin\/guide\/assets(?:\/|$)/,
  /^\/api\/admin\/facility-icons(?:\/|$)/,
];

export function notifyAdminDataChanged(): void {
  if (typeof window === "undefined" || pendingAdminChange) return;
  pendingAdminChange = true;
  window.setTimeout(() => {
    pendingAdminChange = false;
    window.dispatchEvent(new Event(ADMIN_DATA_CHANGED_EVENT));
  }, 0);
}

export function subscribeAdminDataChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(ADMIN_DATA_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ADMIN_DATA_CHANGED_EVENT, listener);
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `Request failed with status ${response.status}`;
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
    const data = body as { error?: ApiErrorBody; status?: string };
    if (data?.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
      return new ApiError(response.status, code, message, data.error.details, body);
    }
    if (typeof data?.status === "string") code = data.status;
  } catch {
    // Non-JSON error body; fall through to status-based message.
  }
  return new ApiError(response.status, code, message, undefined, body);
}

/**
 * Core fetch wrapper. Always sends cookies, parses JSON, and throws ApiError on
 * non-2xx. Use the typed helpers in public.ts / admin.ts rather than calling this directly.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  let body: BodyInit | undefined;

  if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (options.contentType) headers["content-type"] = options.contentType;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }

  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? "GET",
    credentials: "include",
    headers,
    body,
    signal: options.signal,
  });

  if (!response.ok) throw await toApiError(response);

  const method = (options.method ?? "GET").toUpperCase();
  const shouldNotifyAdminChange = path.startsWith("/api/admin/")
    && method !== "GET"
    && method !== "HEAD"
    && !ADMIN_REFRESH_EXCLUSIONS.some((pattern) => pattern.test(path));

  if (response.status === 204) {
    if (shouldNotifyAdminChange) notifyAdminDataChanged();
    return undefined as T;
  }
  const text = await response.text();
  const result = text ? JSON.parse(text) as T : undefined as T;
  if (shouldNotifyAdminChange) notifyAdminDataChanged();
  return result;
}
