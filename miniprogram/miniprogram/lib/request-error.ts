// 把微信 callContainer / wx.request 的原文收成封面文案：错误类型 + 点击重试。
// 不把 errMsg、callId、文档 URL 丢给用户。

export function requestErrorType(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  if (/appid missing/i.test(text)) return "身份缺失";
  if (/-405010|result expired/i.test(text)) return "结果已过期";
  if (/102002|请求超时/.test(text)) return "请求超时";
  if (/请求失败（\d+）/.test(text)) return "请求失败";
  if (/网络请求失败/.test(text)) return "网络异常";
  return "加载失败";
}

export function requestErrorRetryText(raw: unknown): string {
  return `${requestErrorType(raw)}，点击重试`;
}
