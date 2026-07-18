const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export function problem(status: number, code: string, message: string, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

export function noContent(status = 204): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function asErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) return problem(error.status, error.code, error.message, error.details);
  console.error(error);
  return problem(500, "internal_error", "The request could not be completed");
}
