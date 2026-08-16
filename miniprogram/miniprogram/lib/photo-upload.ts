import { apiPostBinary } from "./api";

const MAX_EDGE = 1600;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const COMPRESS_QUALITIES = [80, 60, 40];

export interface PublicPhotoUploadResult {
  mediaId: string;
  byteSize: number;
  contentType: string;
  status: "quarantined";
}

interface PreparedPhoto {
  bytes: ArrayBuffer;
  contentType: string;
}

function readFile(filePath: string): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (result: any) => {
        const data = result.data;
        if (data instanceof ArrayBuffer) resolve(data);
        else reject(new Error("照片读取结果格式不正确"));
      },
      fail: (error: any) => reject(new Error(error.errMsg || "照片读取失败")),
    });
  });
}

function imageSize(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    wx.getImageInfo({
      src,
      success: (result: any) => {
        const width = Number(result.width);
        const height = Number(result.height);
        resolve(width > 0 && height > 0 ? { width, height } : null);
      },
      fail: () => resolve(null),
    });
  });
}

function compressImage(
  src: string,
  quality: number,
  size: { width: number; height: number } | null,
): Promise<string> {
  const options: Record<string, unknown> = { src, quality };
  if (size && Math.max(size.width, size.height) > MAX_EDGE) {
    const ratio = MAX_EDGE / Math.max(size.width, size.height);
    options.compressedWidth = Math.max(1, Math.round(size.width * ratio));
    options.compressedHeight = Math.max(1, Math.round(size.height * ratio));
  }
  return new Promise<string>((resolve, reject) => {
    wx.compressImage({
      ...options,
      success: (result: any) => resolve(String(result.tempFilePath ?? "")),
      fail: (error: any) => reject(new Error(error.errMsg || "照片压缩失败")),
    });
  });
}

/** 只接受服务端白名单内的 JPEG、PNG 与 WebP。 */
export function detectImageContentType(bytes: ArrayBuffer): string | null {
  const view = new Uint8Array(bytes);
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return "image/jpeg";
  if (
    view.length >= 8
    && view[0] === 0x89
    && view[1] === 0x50
    && view[2] === 0x4e
    && view[3] === 0x47
    && view[4] === 0x0d
    && view[5] === 0x0a
    && view[6] === 0x1a
    && view[7] === 0x0a
  ) return "image/png";
  if (
    view.length >= 12
    && view[0] === 0x52
    && view[1] === 0x49
    && view[2] === 0x46
    && view[3] === 0x46
    && view[8] === 0x57
    && view[9] === 0x45
    && view[10] === 0x42
    && view[11] === 0x50
  ) return "image/webp";
  return null;
}

async function preparePhoto(filePath: string): Promise<PreparedPhoto> {
  const original = await readFile(filePath);
  const originalType = detectImageContentType(original);
  const size = await imageSize(filePath);
  const withinDimensions = !size || Math.max(size.width, size.height) <= MAX_EDGE;
  if (originalType && original.byteLength <= MAX_UPLOAD_BYTES && withinDimensions) {
    return { bytes: original, contentType: originalType };
  }

  for (const quality of COMPRESS_QUALITIES) {
    try {
      const compressedPath = await compressImage(filePath, quality, size);
      if (!compressedPath) continue;
      const bytes = await readFile(compressedPath);
      const contentType = detectImageContentType(bytes);
      if (contentType && bytes.byteLength <= MAX_UPLOAD_BYTES) return { bytes, contentType };
    } catch {
      // 继续尝试下一档质量；全部失败后给用户统一提示。
    }
  }
  if (!originalType) throw new Error("请选择 JPEG、PNG 或 WebP 图片");
  throw new Error("照片压缩后仍超过 2MB，请换一张");
}

/** 读取并压缩小程序临时图片，随后上传到投稿隔离区。 */
export async function uploadPublicPhoto(filePath: string): Promise<PublicPhotoUploadResult> {
  const photo = await preparePhoto(filePath);
  return apiPostBinary<PublicPhotoUploadResult>("/api/public/media", photo.bytes, photo.contentType);
}
