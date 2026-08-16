// 小程序渲染层只认本地文件或已配置合法域名。API 数据可经云托管代理读取，
// <image> 自己发出的请求不会经过 api.ts，因此把已取得的 SVG / 媒体字节落到
// USER_DATA_PATH 后再交给渲染层，真机与开发者工具走同一条资源路径。

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "asset";
}

export function writeLocalTextAsset(prefix: string, identity: string, text: string, extension: string): string {
  const fs = wx.getFileSystemManager();
  const path = `${wx.env.USER_DATA_PATH}/${safeSegment(prefix)}-${safeSegment(identity)}.${safeSegment(extension)}`;
  fs.writeFileSync(path, text, "utf8");
  return path;
}

export function writeLocalBinaryAsset(
  prefix: string,
  identity: string,
  bytes: ArrayBuffer,
  extension: string,
): string {
  const fs = wx.getFileSystemManager();
  const path = `${wx.env.USER_DATA_PATH}/${safeSegment(prefix)}-${safeSegment(identity)}.${safeSegment(extension)}`;
  fs.writeFileSync(path, bytes);
  return path;
}

export function removeLocalAsset(path: string | null | undefined): void {
  if (!path) return;
  try {
    wx.getFileSystemManager().unlink({ filePath: path, fail: () => {} });
  } catch {
    // 临时文件清理失败不影响页面主流程。
  }
}

export function mediaExtension(contentType: string): string {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  return "jpg";
}
