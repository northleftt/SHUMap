import { Camera, Plus, RotateCcw, X } from "lucide-react";
import { useRef } from "react";
import type { PhotoUpload } from "../../lib/photos/usePhotoUploads";
import { ImagePreview } from "./ImagePreview";

/**
 * 照片槽位：真实 file input + 缩略图预览 + 删除 / 重试。
 *
 * 字节走 POST /api/public/media（客户端已压缩），组件只展示状态；
 * 上传失败不阻塞文字提交，调用方拿 mediaIds 时天然跳过失败项。
 */
export function PhotoPicker({
  photos,
  slotsLeft,
  onPick,
  onRemove,
  onRetry,
  disabled = false,
  size = "md",
}: {
  photos: PhotoUpload[];
  slotsLeft: number;
  onPick: (files: FileList) => void;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  disabled?: boolean;
  size?: "md" | "sm";
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const box = size === "sm" ? "h-[72px] w-[72px]" : "h-20 w-20";

  return (
    <div className="flex flex-wrap gap-3">
      {photos.map((photo) => (
        <div key={photo.key} className={`relative ${box} overflow-hidden rounded-2xl bg-line/70`}>
          <ImagePreview
            alt="已选照片"
            buttonClassName="h-full w-full"
            imageClassName="h-full w-full object-cover"
            src={photo.previewUrl}
          />
          {photo.status !== "done" ? (
            <div className="absolute inset-0 grid place-items-center bg-black/45 text-center text-[11px] leading-tight text-white">
              {photo.status === "uploading" ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : (
                <button
                  aria-label="重新上传"
                  className="flex flex-col items-center gap-0.5 px-1"
                  onClick={() => onRetry(photo.key)}
                  type="button"
                >
                  <RotateCcw size={14} />
                  重试
                </button>
              )}
            </div>
          ) : null}
          <button
            aria-label="移除照片"
            className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-white"
            onClick={() => onRemove(photo.key)}
            type="button"
          >
            <X size={12} />
          </button>
        </div>
      ))}

      {slotsLeft > 0 && !disabled ? (
        <>
          <button
            aria-label="添加照片"
            className={`grid ${box} place-items-center rounded-2xl border-2 border-dashed border-line text-sub active:bg-page`}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {photos.length === 0 ? <Camera size={size === "sm" ? 22 : 26} /> : <Plus size={size === "sm" ? 18 : 22} />}
          </button>
          <input
            accept="image/*"
            className="hidden"
            multiple={slotsLeft > 1}
            onChange={(event) => {
              const { files } = event.target;
              if (files?.length) onPick(files);
              // 同一张图片再选一次也要触发 change
              event.target.value = "";
            }}
            ref={inputRef}
            type="file"
          />
        </>
      ) : null}
    </div>
  );
}
