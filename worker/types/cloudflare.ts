export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  SHUMAP_BUCKET: R2Bucket;
  IMPORT_QUEUE: Queue;
  RELEASE_COORDINATOR: DurableObjectNamespace;
  ADMIN_BOOTSTRAP_SECRET?: string;
  SESSION_PEPPER: string;
  /**
   * 腾讯地图 WebService key，供 worker/modules/travel-time.ts 的定时采样使用
   * （`wrangler secret put TENCENT_MAP_KEY`）。可选：未配置时采样这一轮直接跳过，
   * 其余功能不受影响。前端只用腾讯的跳转 URI，不需要 key。
   */
  TENCENT_MAP_KEY?: string;
}

export type D1Value = string | number | null | ArrayBuffer;

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Queue {
  send(body: unknown, options?: { contentType?: "json" | "text" | "bytes"; delaySeconds?: number }): Promise<void>;
}

export interface Message<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: Message<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface R2ObjectBody {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
  readonly body: ReadableStream;
  readonly bodyUsed: boolean;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  json<T>(): Promise<T>;
}

export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ key: string; size: number; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string | string[]): Promise<void>;
}

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectState {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
