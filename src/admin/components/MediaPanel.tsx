import { Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import * as admin from "../../lib/api/admin";
import { arrayValue, objectValue, oneOf, optionalString, requiredString } from "../../lib/dataContract";
import { ErrorBanner, GhostButton, InfoNote, Panel, Pill, errorMessage } from "./primitives";

export interface MediaRow {
  id?: string;
  role: "cover" | "gallery";
  url: string;
  alt?: string;
  caption?: string;
  floorLevelCode?: string;
}

/**
 * content.media → 表单行。
 *
 * 缺字段等于「没有照片」，不是数据坏了：设施与商户的 media 在存储契约里是可选的
 * （`validateOptionalMedia` 只在字段存在时校验），编辑器保存时也会在没有照片时
 * 主动 `delete content.media`。所以一个从没传过照片的设施，content 就是 `{}`，
 * 之前这里直接 `arrayValue(undefined)` 抛出「media must be an array」，把整个
 * 编辑页挡在门外 —— 恰恰是最常见的那种设施打不开。
 */
export function readMedia(value: unknown): MediaRow[] {
  if (value === undefined || value === null) return [];
  return arrayValue(value, "media").map((raw, index) => {
    const field = `media[${index}]`;
    const row = objectValue(raw, field);
    const id = optionalString(row.id, `${field}.id`);
    const alt = optionalString(row.alt, `${field}.alt`);
    const caption = optionalString(row.caption, `${field}.caption`);
    const floorLevelCode = optionalString(row.floorLevelCode, `${field}.floorLevelCode`);
    return {
      role: oneOf(row.role, `${field}.role`, ["cover", "gallery"] as const),
      url: requiredString(row.url, `${field}.url`),
      ...(id === undefined ? {} : { id }),
      ...(alt === undefined ? {} : { alt }),
      ...(caption === undefined ? {} : { caption }),
      ...(floorLevelCode === undefined ? {} : { floorLevelCode }),
    };
  });
}

export function MediaPanel({ media, onChange, disabled }: { media: MediaRow[]; onChange(rows: MediaRow[]): void; disabled?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      const added: MediaRow[] = [];
      for (const file of Array.from(files)) {
        const result = await admin.uploadAdminMedia(file);
        added.push({ role: media.length + added.length === 0 ? "cover" : "gallery", url: result.url });
      }
      onChange([...media, ...added]);
    } catch (err) { setError(errorMessage(err, "图片上传失败")); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  return (
    <Panel title={`图片${media.length ? `（${media.length}）` : ""}`} action={<GhostButton disabled={disabled || uploading} onClick={() => fileRef.current?.click()}><Upload size={14} />{uploading ? "上传中…" : "上传图片"}</GhostButton>}>
      <input accept="image/jpeg,image/png,image/webp" className="hidden" multiple onChange={(e) => void upload(e.target.files)} ref={fileRef} type="file" />
      <ErrorBanner message={error} />
      {media.length === 0 ? <InfoNote>还没有图片</InfoNote> : (
        <div className="space-y-2">
          {media.map((row, index) => <div className="flex items-center gap-3 rounded-lg border border-line p-2" key={`${row.url}:${index}`}>
            <img alt="" className="h-14 w-20 rounded object-cover" src={row.url} />
            <span className="min-w-0 flex-1 truncate text-label text-sub">{row.role === "cover" ? <Pill tone="info">封面</Pill> : row.url}</span>
            {row.role !== "cover" ? <GhostButton disabled={disabled} onClick={() => onChange(media.map((item, i) => ({ ...item, role: i === index ? "cover" : "gallery" })))}>设为封面</GhostButton> : null}
            <GhostButton danger disabled={disabled} onClick={() => onChange(media.filter((_, i) => i !== index))}><Trash2 size={14} /></GhostButton>
          </div>)}
        </div>
      )}
    </Panel>
  );
}
