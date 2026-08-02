// 用户照片上传：canvas 压缩 + POST /api/public/media（隔离区），
// 提交时只把返回的 mediaId 放进 payload。上传失败不阻塞文字提交，
// 失败项留在列表里可单独重试或删除。

import { useCallback, useRef, useState } from "react";
import { uploadPublicPhoto } from "../api/public";

/** 压缩目标：最长边 1600px，JPEG q=0.8。服务端硬上限 2MiB。 */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type PhotoUploadStatus = "uploading" | "done" | "error";

export interface PhotoUpload {
  /** 本地临时 key，渲染与删除用。 */
  key: string;
  /** objectURL，用于缩略图预览；done 之后仍可继续用。 */
  previewUrl: string;
  status: PhotoUploadStatus;
  /** 上传成功后的 media id；提交时收集这些。 */
  mediaId: string | null;
  error: string | null;
}

let photoSeq = 0;
function nextKey(): string {
  photoSeq += 1;
  return `photo_${Date.now().toString(36)}_${photoSeq}`;
}

/**
 * 把任意图片文件画到 canvas 上按最长边缩放后导出 JPEG。
 * 解码、绘制和编码中的任一步失败都会进入照片失败状态。
 */
export async function compressImage(file: File): Promise<Blob> {
  const bitmap = await loadBitmap(file);
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建照片压缩画布");
    context.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/jpeg", JPEG_QUALITY);
    });
    if (!blob) throw new Error("浏览器无法编码压缩后的照片");
    return blob;
  } finally {
    if ("close" in bitmap) bitmap.close();
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // 浏览器位图解码不可用时，继续使用 <img> 解码同一文件。
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("照片解码失败，请选择可读取的图片"));
      image.src = url;
    });
  } finally {
    // 解码完成后 revoke；已 decode 的位图不再需要这个 URL。
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * 一组照片槽位的上传状态机。
 *
 * @param maximum 槽位上限（反馈 3 张，采集大门 3 张、每层 2 张）。
 */
export function usePhotoUploads(maximum: number) {
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  // 重试需要原始 File，不放进 state（避免无谓的相等性比较）。
  const files = useRef(new Map<string, File>());

  const runUpload = useCallback(async (key: string, file: File) => {
    try {
      const blob = await compressImage(file);
      if (blob.size > MAX_UPLOAD_BYTES) {
        throw new Error("照片过大，请换一张");
      }
      const result = await uploadPublicPhoto(blob);
      setPhotos((current) =>
        current.map((photo) =>
          photo.key === key ? { ...photo, status: "done", mediaId: result.mediaId, error: null } : photo,
        ),
      );
    } catch (error) {
      setPhotos((current) =>
        current.map((photo) =>
          photo.key === key
            ? { ...photo, status: "error", mediaId: null, error: error instanceof Error ? error.message : "上传失败" }
            : photo,
        ),
      );
    }
  }, []);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming).filter((file) => file.type.startsWith("image/"));
      if (!list.length) return;
      setPhotos((current) => {
        const room = Math.max(0, maximum - current.length);
        const accepted = list.slice(0, room);
        const added = accepted.map((file) => {
          const key = nextKey();
          files.current.set(key, file);
          void runUpload(key, file);
          return {
            key,
            previewUrl: URL.createObjectURL(file),
            status: "uploading" as const,
            mediaId: null,
            error: null,
          };
        });
        return [...current, ...added];
      });
    },
    [maximum, runUpload],
  );

  const remove = useCallback((key: string) => {
    setPhotos((current) => {
      const target = current.find((photo) => photo.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      files.current.delete(key);
      return current.filter((photo) => photo.key !== key);
    });
  }, []);

  const retry = useCallback(
    (key: string) => {
      const file = files.current.get(key);
      if (!file) return;
      setPhotos((current) =>
        current.map((photo) => (photo.key === key ? { ...photo, status: "uploading", error: null } : photo)),
      );
      void runUpload(key, file);
    },
    [runUpload],
  );

  const reset = useCallback(() => {
    setPhotos((current) => {
      for (const photo of current) URL.revokeObjectURL(photo.previewUrl);
      return [];
    });
    files.current.clear();
  }, []);

  return {
    photos,
    addFiles,
    remove,
    retry,
    reset,
    /** 已上传成功的 media id，按加入顺序。提交时直接放进 payload。 */
    mediaIds: photos.filter((photo) => photo.mediaId).map((photo) => photo.mediaId!),
    uploading: photos.some((photo) => photo.status === "uploading"),
    failedCount: photos.filter((photo) => photo.status === "error").length,
    slotsLeft: Math.max(0, maximum - photos.length),
  };
}
