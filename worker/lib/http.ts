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

export async function readJsonLimited<T>(request: Request, maximumBytes: number): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }
  const bytes = await readBodyLimited(request, maximumBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

export async function readBodyLimited(request: Request, maximumBytes: number): Promise<ArrayBuffer> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new HttpError(400, "invalid_content_length", "Content-Length must be a non-negative integer");
    }
    if (declared > maximumBytes) {
      throw new HttpError(413, "payload_too_large", `Request body must be at most ${maximumBytes} bytes`);
    }
  }
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new HttpError(413, "payload_too_large", `Request body must be at most ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
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
