// 只读公开 API 封装：统一走 GET，双通道（云托管代理 / wx.request 本地调试）。
// 对应 Web 端 src/lib/api/public.ts 的读端，错误语义简化：非 2xx 一律 reject。

import { config } from "../config";

export interface ApiError extends Error {
  statusCode?: number;
}

function buildQuery(query?: Record<string, string | null | undefined>): string {
  if (!query) return "";
  const parts = Object.keys(query)
    .filter((key) => query[key] !== null && query[key] !== undefined && query[key] !== "")
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key] as string)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function makeError(message: string, statusCode?: number): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  return error;
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
          reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
          reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
        else reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
        else reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
        else reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
        else reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
          reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
          reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
        reject(makeError(`请求失败（${res.statusCode}）`, res.statusCode));
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
