import { ClipboardList, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EmptyState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { PhotoPicker } from "../../components/ui/PhotoPicker";
import { SheetModal } from "../../components/ui/SheetModal";
import { facilityIcon } from "../../lib/facilityIcons";
import { usePhotoUploads } from "../../lib/photos/usePhotoUploads";
import { useRelease } from "../../lib/release/ReleaseContext";
import {
  isLockExpired,
  useCollectionTasks,
  type CollectedFacility,
  type CollectedFloor,
} from "../../lib/storage/collectionTasks";

/** 与 worker 端 collections.ts 的 MAX_ENTRANCE_PHOTOS / MAX_FLOOR_PHOTOS 一致。 */
const MAX_ENTRANCE_PHOTOS = 3;
const MAX_FLOOR_PHOTOS = 2;

const FACILITY_TYPE_OPTIONS = [
  { code: "restroom", label: "卫生间" },
  { code: "elevator", label: "电梯" },
  { code: "drinking_water", label: "饮水机" },
  { code: "printer", label: "打印机" },
  { code: "study_area", label: "研习空间" },
  { code: "vending_machine", label: "售货机" },
  { code: "power_bank", label: "充电宝" },
];

function facilityTypeLabel(code: string): string {
  return FACILITY_TYPE_OPTIONS.find((option) => option.code === code)?.label ?? code;
}

let facilitySeq = 0;
function nextLocalId(prefix: string): string {
  facilitySeq += 1;
  return `local_${prefix}_${Date.now().toString(36)}_${facilitySeq}`;
}

/**
 * 采集照片槽位：已保存在草稿里的 media id + 本次新选的上传。
 *
 * 草稿里只有 id（字节早已经 POST /api/public/media 落到隔离区），刷新后拿不回本地
 * 预览，所以已保存的那部分用 `/api/public/media/:id` 占位——审核通过后这个地址才
 * 真正可读，在此之前显示为「已上传」缩略占位。
 */
function CollectionPhotoField({
  committed,
  maximum,
  onCommittedChange,
  uploads,
  disabled = false,
}: {
  committed: string[];
  maximum: number;
  onCommittedChange: (ids: string[]) => void;
  uploads: ReturnType<typeof usePhotoUploads>;
  disabled?: boolean;
}) {
  const slotsLeft = Math.max(0, maximum - committed.length - uploads.photos.length);
  return (
    <div className="mt-2.5 space-y-2">
      {committed.length ? (
        <div className="flex flex-wrap gap-3">
          {committed.map((mediaId) => (
            <div key={mediaId} className="relative h-20 w-20 overflow-hidden rounded-2xl bg-line/70">
              <div className="grid h-full w-full place-items-center text-center text-[11px] leading-tight text-sub">
                已上传
              </div>
              {disabled ? null : (
                <button
                  aria-label="移除照片"
                  className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-white"
                  onClick={() => onCommittedChange(committed.filter((id) => id !== mediaId))}
                  type="button"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <PhotoPicker
        disabled={disabled}
        onPick={uploads.addFiles}
        onRemove={uploads.remove}
        onRetry={uploads.retry}
        photos={uploads.photos}
        slotsLeft={slotsLeft}
      />
      {uploads.failedCount ? (
        <p className="text-aux text-error">{uploads.failedCount} 张照片上传失败，可点击缩略图重试；不影响文字提交。</p>
      ) : null}
    </div>
  );
}

/** M13 楼层详情弹卡：位置描述 + 设施行 + 添加设施。 */
function FloorDetailModal({
  floor,
  onSave,
  onClose,
}: {
  floor: CollectedFloor | null;
  onSave: (floor: CollectedFloor) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CollectedFloor | null>(floor);
  const [addingType, setAddingType] = useState(false);
  const floorUploads = usePhotoUploads(MAX_FLOOR_PHOTOS);
  const { reset: resetFloorUploads } = floorUploads;

  // 这张卡片常驻挂载（无楼层时渲染 null），切换楼层时必须清掉上一层的待上传项。
  useEffect(() => {
    setDraft(floor);
    resetFloorUploads();
  }, [floor, resetFloorUploads]);
  if (!floor || !draft) return null;

  const updateFacility = (id: string, patch: Partial<CollectedFacility>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            facilities: current.facilities.map((facility) =>
              facility.id === id ? { ...facility, ...patch } : facility,
            ),
          }
        : current,
    );
  };

  return (
    <SheetModal open onClose={onClose} expandable initialHeight={0.72}>
      <div className="px-5 pb-8">
        <div className="flex items-center justify-between">
          <h2 className="text-card">{draft.levelCode} 楼层信息</h2>
          <button
            type="button"
            aria-label="关闭"
            className="grid h-8 w-8 place-items-center rounded-full bg-page text-sub"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <input
          className="mt-3 w-full rounded-xl bg-page px-3.5 py-2.5 text-body text-ink outline-none placeholder:text-sub"
          placeholder="位置描述：如 自东向西分别为 301–330 教室"
          value={draft.note}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />

        <div className="mt-4">
          {draft.facilities.map((facility, index) => {
            const Icon = facilityIcon(facility.typeCode);
            return (
              <div key={facility.id} className={`py-3 ${index > 0 ? "border-t border-line" : ""}`}>
                <div className="flex items-center gap-2.5">
                  <Icon size={17} className="shrink-0 text-primary" />
                  <span className="flex-1 text-body font-semibold text-ink">
                    {facility.name || facilityTypeLabel(facility.typeCode)}
                  </span>
                  <button
                    type="button"
                    aria-label="删除设施"
                    className="grid h-8 w-8 place-items-center rounded-lg bg-page text-sub active:text-error"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        facilities: draft.facilities.filter((item) => item.id !== facility.id),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <input
                  className="mt-2 w-full rounded-lg bg-page px-3 py-2 text-aux text-ink outline-none placeholder:text-sub"
                  placeholder="位置描述：如 最东侧"
                  value={facility.locationText}
                  onChange={(event) => updateFacility(facility.id, { locationText: event.target.value })}
                />
              </div>
            );
          })}
        </div>

        {addingType ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {FACILITY_TYPE_OPTIONS.map((option) => (
              <button
                key={option.code}
                type="button"
                className="rounded-full bg-primary-container px-3.5 py-2 text-aux font-medium text-primary active:opacity-80"
                onClick={() => {
                  setDraft({
                    ...draft,
                    facilities: [
                      ...draft.facilities,
                      { id: nextLocalId("fac"), typeCode: option.code, name: "", locationText: "" },
                    ],
                  });
                  setAddingType(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-primary/40 py-3 text-body font-medium text-primary active:bg-primary-container"
            onClick={() => setAddingType(true)}
          >
            <Plus size={16} />
            添加设施
          </button>
        )}

        <h3 className="mt-5 text-emphasis">现场照片（需要：该层平面图照片）</h3>
        <CollectionPhotoField
          committed={draft.photoMediaIds ?? []}
          maximum={MAX_FLOOR_PHOTOS}
          onCommittedChange={(ids) => setDraft({ ...draft, photoMediaIds: ids })}
          uploads={floorUploads}
        />

        <button
          type="button"
          className="mt-6 w-full rounded-full bg-primary py-3 text-body font-semibold text-white active:bg-primary-pressed"
          onClick={() => {
            // 新上传的照片在保存时并入该层，超出上限的多余项丢弃。
            onSave({
              ...draft,
              photoMediaIds: [...(draft.photoMediaIds ?? []), ...floorUploads.mediaIds].slice(0, MAX_FLOOR_PHOTOS),
            });
            onClose();
          }}
        >
          保存
        </button>
      </div>
    </SheetModal>
  );
}

/** M13 数据采集-表单。 */
export function CollectionFormPage() {
  const { buildingId = "" } = useParams();
  const navigate = useNavigate();
  const { release } = useRelease();
  const { getTask, saveDraft, submitCollection, error } = useCollectionTasks();

  const building = useMemo(
    () => release?.buildings.find((b) => b.poiKey === buildingId) ?? null,
    [release, buildingId],
  );
  const task = getTask(buildingId);
  const [editingFloor, setEditingFloor] = useState<CollectedFloor | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const entranceUploads = usePhotoUploads(MAX_ENTRANCE_PHOTOS);
  // 本次会话上传成功的 id：用来把「草稿里已有的」和「刚上传的」区分开，
  // 这样删除一个待上传项时也能把它从草稿里摘掉。
  const sessionIds = useRef(new Set<string>());
  for (const mediaId of entranceUploads.mediaIds) sessionIds.current.add(mediaId);

  const draftPhotoIds = task?.photoMediaIds ?? [];
  const entranceCommitted = draftPhotoIds.filter((id) => !sessionIds.current.has(id));
  const desiredPhotoIds = [...entranceCommitted, ...entranceUploads.mediaIds].slice(0, MAX_ENTRANCE_PHOTOS);

  // 大门照片没有独立的「保存」按钮，上传完成 / 删除后直接同步进采集草稿。
  const desiredKey = desiredPhotoIds.join(",");
  useEffect(() => {
    if (!task || task.status !== "collecting" || !task.owned) return;
    if (desiredKey === draftPhotoIds.join(",")) return;
    saveDraft(buildingId, { photoMediaIds: desiredKey ? desiredKey.split(",") : [] });
  }, [buildingId, desiredKey, draftPhotoIds, saveDraft, task]);

  if (!task) {
    return (
      <div className="flex h-full flex-col bg-page">
        <PageHeader title="数据采集" onBack={() => navigate("/collect")} />
        <EmptyState
          title="尚未开始采集"
          subtitle="请先在列表中锁定该楼宇"
          action={
            <button
              type="button"
              className="rounded-full bg-primary px-6 py-2.5 text-body font-semibold text-white"
              onClick={() => navigate("/collect")}
            >
              返回列表
            </button>
          }
        />
      </div>
    );
  }

  const lockExpired = isLockExpired(task, Date.now());
  // 别人正在采这栋楼：本机只读，且看不到对方的草稿正文（服务器只把草稿回给持有者）。
  const lockedByOther = task.status === "collecting" && !task.owned && !lockExpired;
  const readOnly = task.status !== "collecting" || !task.owned || lockExpired;

  const field = (
    label: string,
    value: string,
    key: "phone" | "openHours" | "organization",
    placeholder: string,
  ) => (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <span className="w-16 shrink-0 text-body text-sub">{label}</span>
      <input
        className="min-w-0 flex-1 bg-transparent text-right text-body text-ink outline-none placeholder:text-line"
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(event) => saveDraft(buildingId, { [key]: event.target.value })}
      />
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-page">
      <PageHeader
        title={`${building?.name ?? "楼宇"} · 数据采集`}
        onBack={() => navigate("/collect")}
      />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {/* 基本信息 */}
        <h2 className="mt-2 text-emphasis">基本信息</h2>
        <div className="mt-2.5 divide-y divide-line rounded-2xl bg-surface shadow-card">
          {field("联系电话", task.phone, "phone", "选填")}
          {field("开放时间", task.openHours, "openHours", "如 07:30 – 22:00")}
          {field("所属单位", task.organization, "organization", "如 管理学院")}
        </div>

        {/* 楼层信息 */}
        <h2 className="mt-5 text-emphasis">楼层信息（{task.floors.length}）</h2>
        <div className="mt-2.5 rounded-2xl bg-surface shadow-card">
          {task.floors.map((floor, index) => (
            <button
              key={floor.id}
              type="button"
              disabled={readOnly}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-page ${
                index > 0 ? "border-t border-line" : ""
              } ${readOnly ? "cursor-default" : ""}`}
              onClick={() => { if (!readOnly) setEditingFloor(floor); }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-body font-semibold text-ink">{floor.levelCode}</div>
                <div className="mt-0.5 truncate text-aux text-sub">
                  已记录：{floor.facilities.map((f) => f.name || facilityTypeLabel(f.typeCode)).join("，") || "—"}
                </div>
              </div>
              <ClipboardList size={17} className="shrink-0 text-sub" />
            </button>
          ))}
          {!readOnly ? (
            <button
              type="button"
              className={`flex w-full items-center justify-center gap-1.5 px-4 py-3.5 text-body font-medium text-primary active:bg-primary-container ${
                task.floors.length > 0 ? "border-t border-line" : ""
              }`}
              onClick={() => {
                const level = window.prompt("楼层名称（如 一层 / 3F）");
                if (!level?.trim()) return;
                const floor: CollectedFloor = {
                  id: nextLocalId("floor"),
                  levelCode: level.trim(),
                  note: "",
                  facilities: [],
                };
                saveDraft(buildingId, { floors: [...task.floors, floor] });
                setEditingFloor(floor);
              }}
            >
              <Plus size={16} />
              添加楼层
            </button>
          ) : null}
        </div>

        {/* 大门照片：上传到隔离区，审核采纳后才公开 */}
        <h2 className="mt-5 text-emphasis">现场照片（需要：大门照片）</h2>
        <CollectionPhotoField
          committed={entranceCommitted}
          disabled={readOnly}
          maximum={MAX_ENTRANCE_PHOTOS}
          onCommittedChange={(ids) =>
            saveDraft(buildingId, { photoMediaIds: [...ids, ...entranceUploads.mediaIds].slice(0, MAX_ENTRANCE_PHOTOS) })
          }
          uploads={entranceUploads}
        />

        {/* 操作 */}
        {readOnly ? (
          <p className="mt-6 text-center text-aux text-sub">
            {lockedByOther
              ? `${task.assignee ?? "其他志愿者"} 正在采集这栋楼，暂时无法编辑`
              : lockExpired
                ? "领取已超时，请返回列表重新领取"
                : task.status === "needs_recollection"
                  ? "审核要求补充采集，请返回列表领取任务"
                  : `已于 ${task.submittedAt ? new Date(task.submittedAt).toLocaleDateString("zh-CN") : "—"} 提交，状态：${task.status === "accepted" ? "已采纳" : "待审核"}`}
          </p>
        ) : (
          <>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-full bg-surface py-3.5 text-body font-semibold text-ink shadow-card active:bg-page"
                onClick={() => navigate("/collect")}
              >
                保存草稿
              </button>
              <button
                type="button"
                className="flex-1 rounded-full bg-primary py-3.5 text-body font-semibold text-white active:bg-primary-pressed"
                onClick={() => {
                  if (submitting) return;
                  setSubmitting(true);
                  void submitCollection(buildingId)
                    .then((ok) => {
                      if (!ok) return;
                      setSubmitted(true);
                      window.setTimeout(() => navigate("/collect"), 900);
                    })
                    .finally(() => setSubmitting(false));
                }}
                disabled={submitting}
              >
                {submitted ? "已提交 ✓" : submitting ? "提交中…" : "提交采集"}
              </button>
            </div>
            <p className="mt-3 text-center text-aux text-sub">提交后数据会进入管理后台审核队列</p>
            {error ? <p className="mt-2 text-center text-aux text-error">{error}</p> : null}
          </>
        )}
      </div>

      <FloorDetailModal
        floor={editingFloor}
        onClose={() => setEditingFloor(null)}
        onSave={(floor) =>
          saveDraft(buildingId, {
            floors: task.floors.map((item) => (item.id === floor.id ? floor : item)),
          })
        }
      />
    </div>
  );
}
