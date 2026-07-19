import { Camera, ClipboardList, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { EmptyState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { SheetModal } from "../../components/ui/SheetModal";
import { facilityIcon } from "../../lib/facilityIcons";
import { useRelease } from "../../lib/release/ReleaseContext";
import {
  useCollectionTasks,
  type CollectedFacility,
  type CollectedFloor,
} from "../../lib/storage/collectionTasks";

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

  useEffect(() => setDraft(floor), [floor]);
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

        {/* 现场照片（UI-only） */}
        <h3 className="mt-5 text-emphasis">现场照片（需要：该层平面图照片）</h3>
        <div className="mt-2.5 flex gap-3">
          <div className="grid h-20 w-20 place-items-center rounded-2xl bg-line/70 text-sub">
            <Camera size={24} />
          </div>
          <div className="grid h-20 w-20 place-items-center rounded-2xl border-2 border-dashed border-line text-sub">
            <Plus size={20} />
          </div>
        </div>

        <button
          type="button"
          className="mt-6 w-full rounded-full bg-primary py-3 text-body font-semibold text-white active:bg-primary-pressed"
          onClick={() => {
            onSave(draft);
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
  const { getTask, saveDraft, submitCollection } = useCollectionTasks();

  const building = useMemo(
    () => release?.buildings.find((b) => b.poiKey === buildingId) ?? null,
    [release, buildingId],
  );
  const task = getTask(buildingId);
  const [editingFloor, setEditingFloor] = useState<CollectedFloor | null>(null);
  const [submitted, setSubmitted] = useState(false);

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

  const readOnly = task.status === "submitted";

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
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-page ${
                index > 0 ? "border-t border-line" : ""
              }`}
              onClick={() => setEditingFloor(floor)}
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

        {/* 现场照片（UI-only） */}
        <h2 className="mt-5 text-emphasis">现场照片（需要：大门照片）</h2>
        <div className="mt-2.5 flex gap-3">
          <div className="grid h-20 w-20 place-items-center rounded-2xl bg-line/70 text-sub">
            <Camera size={24} />
          </div>
          <div className="grid h-20 w-20 place-items-center rounded-2xl border-2 border-dashed border-line text-sub">
            <Plus size={20} />
          </div>
        </div>

        {/* 操作 */}
        {readOnly ? (
          <p className="mt-6 text-center text-aux text-sub">
            已于 {task.submittedAt ? new Date(task.submittedAt).toLocaleDateString("zh-CN") : "—"} 提交，审核进度可在「我的」查看
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
                  submitCollection(buildingId);
                  setSubmitted(true);
                  window.setTimeout(() => navigate("/collect"), 900);
                }}
              >
                {submitted ? "已提交 ✓" : "提交采集"}
              </button>
            </div>
            <p className="mt-3 text-center text-aux text-sub">提交即锁定该楼宇，可在「我的」查看审核进度</p>
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
