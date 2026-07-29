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

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
