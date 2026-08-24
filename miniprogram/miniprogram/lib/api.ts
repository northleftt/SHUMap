// 只读公开 API 封装：统一走 GET，双通道（云托管代理 / wx.request 本地调试）。
// 对应 Web 端 src/lib/api/public.ts 的读端，错误语义简化：非 2xx 一律 reject。

import { config } from "../config";

export interface ApiError extends Error {
  statusCode?: number;
  /** 服务端 `{error:{code}}` 的机器可读错误码，调用方按码分支（如 rate_limited）。 */
  code?: string;
}

function buildQuery(query?: Record<string, string | null | undefined>): string {
  if (!query) return "";
  const parts = Object.keys(query)
    .filter((key) => query[key] !== null && query[key] !== undefined && query[key] !== "")
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key] as string)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function makeError(message: string, statusCode?: number, code?: string): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/**
 * 非 2xx 响应 → 错误对象，优先用服务端 `{error:{code,message}}` 里的 message。
 *
 * 只报「请求失败（400）」对提交类操作是不够的：worker 会明确说出是哪条校验没过
 * （stale_base_revision / rate_limited / media_not_attachable…），把这句原文带出来，
 * 用户和排查的人才知道下一步该做什么。data 可能已被解析成对象，也可能还是字符串。
 */
function responseError(res: any): ApiError {
  const status = res?.statusCode;
  let data = res?.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }
  const detail = data && typeof data === "object" ? (data as any).error : null;
  const message = detail && typeof detail.message === "string" && detail.message !== ""
    ? detail.message
    : `请求失败（${status}）`;
  const code = detail && typeof detail.code === "string" ? detail.code : undefined;
  return makeError(message, status, code);
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string {
  if (!headers) return "";
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
  return key ? String(headers[key] ?? "") : "";
}

/** GET 云托管容器（wx.cloud.callContainer）。 */
function cloudGet<T>(path: string, query?: Record<string, string | null | undefined>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: config.cloudEnv },
      path: `${path}${buildQuery(query)}`,
      method: "GET",
      service: config.cloudService,
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T);
        } else {
          reject(responseError(res));
        }
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

/** GET wx.request 直连（本地调试）。 */
function requestGet<T>(path: string, query?: Record<string, string | null | undefined>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}${buildQuery(query)}`,
      method: "GET",
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T);
        } else {
          reject(responseError(res));
        }
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

function cloudPost<T>(path: string, body: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: config.cloudEnv },
      path,
      method: "POST",
      service: config.cloudService,
      header: { "content-type": "application/json" },
      data: body,
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data as T);
        else reject(responseError(res));
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

function requestPost<T>(path: string, body: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: "POST",
      header: { "content-type": "application/json" },
      data: body,
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data as T);
        else reject(responseError(res));
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

/** POST 原始二进制到云托管容器。用于公开投稿照片。 */
function cloudPostBinary<T>(path: string, body: ArrayBuffer, contentType: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: config.cloudEnv },
      path,
      method: "POST",
      service: config.cloudService,
      // v1 原生封装 ArrayBuffer；v2 对直接二进制输入有 100KB 限制，无法覆盖投稿照片上限。
      apiVersion: 1,
      header: { "content-type": contentType },
      data: body,
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data as T);
        else reject(responseError(res));
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

/** POST 原始二进制到直连 API。 */
function requestPostBinary<T>(path: string, body: ArrayBuffer, contentType: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: "POST",
      header: { "content-type": contentType },
      data: body,
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data as T);
        else reject(responseError(res));
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

export function apiGet<T>(path: string, query?: Record<string, string | null | undefined>): Promise<T> {
  return config.useCloudContainer ? cloudGet<T>(path, query) : requestGet<T>(path, query);
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return config.useCloudContainer ? cloudPost<T>(path, body) : requestPost<T>(path, body);
}

/** POST 原始二进制，双通道与 JSON API 保持一致。 */
export function apiPostBinary<T>(path: string, body: ArrayBuffer, contentType: string): Promise<T> {
  return config.useCloudContainer
    ? cloudPostBinary<T>(path, body, contentType)
    : requestPostBinary<T>(path, body, contentType);
}

/** GET 云托管容器，原文返回（SVG 等非 JSON 响应）。 */
function cloudGetText(path: string, query?: Record<string, string | null | undefined>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: config.cloudEnv },
      path: `${path}${buildQuery(query)}`,
      method: "GET",
      service: config.cloudService,
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(typeof res.data === "string" ? res.data : String(res.data));
        } else {
          reject(responseError(res));
        }
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

/** GET wx.request 直连，原文返回（dataType: "其他" 不做 JSON 解析）。 */
function requestGetText(path: string, query?: Record<string, string | null | undefined>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}${buildQuery(query)}`,
      method: "GET",
      dataType: "其他",
      success: (res: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(typeof res.data === "string" ? res.data : String(res.data));
        } else {
          reject(responseError(res));
        }
      },
      fail: (err: any) => reject(makeError(err.errMsg || "网络请求失败")),
    });
  });
}

/**
 * GET 非 JSON 资源（如 SVG 底图 GET /api/public/maps/:mapVersionId/asset）。
 * 与 apiGet 同双通道、同错误语义（非 2xx 一律 reject）。
 */
export function apiGetText(path: string, query?: Record<string, string | null | undefined>): Promise<string> {
  return config.useCloudContainer ? cloudGetText(path, query) : requestGetText(path, query);
}

export interface ApiBinaryResponse {
  data: ArrayBuffer;
  contentType: string;
}

/** GET 二进制资源。用于需要经云托管代理落到 USER_DATA_PATH 的公开图片。 */
export function apiGetBinary(path: string): Promise<ApiBinaryResponse> {
  return new Promise<ApiBinaryResponse>((resolve, reject) => {
    const success = (res: any) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(responseError(res));
        return;
      }
      if (!(res.data instanceof ArrayBuffer)) {
        reject(makeError("资源响应格式不正确", res.statusCode));
        return;
      }
      resolve({ data: res.data, contentType: headerValue(res.header, "content-type") });
    };
    const fail = (err: any) => reject(makeError(err.errMsg || "网络请求失败"));
    if (config.useCloudContainer) {
      wx.cloud.callContainer({
        config: { env: config.cloudEnv },
        path,
        method: "GET",
        service: config.cloudService,
        dataType: "其他",
        responseType: "arraybuffer",
        success,
        fail,
      });
      return;
    }
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: "GET",
      dataType: "其他",
      responseType: "arraybuffer",
      success,
      fail,
    });
  });
}
