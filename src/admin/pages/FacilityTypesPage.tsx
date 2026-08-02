import { ChevronDown, ChevronRight, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type { FacilityTypeInstanceRow, FacilityTypeMapFilterCategory, FacilityTypeRow } from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import { facilityIconByKey, facilityIconKeyLabel } from "../../lib/facilityIcons";
import { useAuth } from "../AuthContext";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SelectField,
  errorMessage,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// 设施类型（标签）管理。
//
// 「不要某个标签了」分两种情况，界面上区分清楚：
//   · 已经挂了点位 → 只能停用。停用后不再出现在新建设施和志愿者采集的可选项里，
//     但既有点位照常展示与发布，历史数据不受影响。
//   · 没有点位和采集记录引用 → 可以直接删除。
// ---------------------------------------------------------------------------

const ERROR_TEXT: Record<string, string> = {
  code_taken: "这个英文编码已经被别的类型占用了，换一个再试。",
  invalid_code: "英文编码只能用小写字母、数字和下划线，并以字母开头。",
  code_immutable: "已有类型的英文编码不能修改。要换编码请新建一个类型，再把旧的停用。",
  unsupported_icon_key: "选择的图标不在支持范围内，请重新选择。",
  facility_type_in_use: "这个类型仍被点位或采集记录引用，不能删除。可以先停用它。",
  inactive_map_filter: "启用中的设施类型必须归入启用中的地图分类。",
  map_filter_in_use: "这个地图分类仍承载使用中的内容，当前操作无法完成。",
  validation_error: "填写的内容不完整或不正确，请检查后重试。",
  forbidden: "当前账号没有维护设施类型的权限。",
  unauthorized: "登录状态已失效，请重新登录。",
  not_found: "这个类型不存在，可能已被其他人改动，刷新后再试。",
};

function typeError(err: unknown, defaultMessage: string): string {
  if (err instanceof ApiError) return ERROR_TEXT[err.code] ?? defaultMessage;
  return errorMessage(err, defaultMessage);
}

/** 分类只用于分组展示，中文名在这里定；接口给的是英文键。 */
const CATEGORY_LABELS: Record<string, string> = {
  service: "服务",
  study: "学习",
  amenity: "生活便利",
  navigation: "通行",
  commercial: "商业",
  transport: "交通",
  other: "其他",
};

function categoryLabel(key: string): string {
  return CATEGORY_LABELS[key] ?? "其他";
}

const OPERATIONAL_LABELS: Record<string, string> = {
  available: "可用",
  partially_available: "部分可用",
  unavailable: "不可用",
  unknown: "状态未知",
};

const LIFECYCLE_LABELS: Record<string, string> = {
  planned: "筹备中",
  active: "使用中",
  retired: "已撤除",
};

/** 图标预览 + 名称，下拉旁边显示当前选择。 */
function IconPreview({ iconKey, size = 18 }: { iconKey: string | null; size?: number }) {
  const Icon = facilityIconByKey(iconKey);
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-container text-primary">
      <Icon size={size} />
    </span>
  );
}

/** 带预览的图标选择：下拉选 key，左边实时显示图标长什么样。 */
function IconChooser({
  value,
  iconKeys,
  onChange,
}: {
  value: string;
  iconKeys: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-label text-sub">图标</span>
      <div className="flex items-center gap-2.5">
        <IconPreview iconKey={value || null} />
        <div className="flex-1">
          <SelectField
            onChange={onChange}
            options={iconKeys.map((key) => ({ value: key, label: facilityIconKeyLabel(key) }))}
            value={value}
          />
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {iconKeys.map((key) => {
          const Icon = facilityIconByKey(key);
          const active = key === value;
          return (
            <button
              aria-label={facilityIconKeyLabel(key)}
              aria-pressed={active}
              className={`grid h-8 w-8 place-items-center rounded-lg border transition-colors ${
                active ? "border-primary bg-primary-container text-primary" : "border-line text-sub hover:text-ink"
              }`}
              key={key}
              onClick={() => onChange(key)}
              title={facilityIconKeyLabel(key)}
              type="button"
            >
              <Icon size={16} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 新建 / 编辑表单。editing 为空即新建。 */
function TypeForm({
  editing,
  iconKeys,
  categories,
  mapFilterCategories,
  onClose,
  onSaved,
}: {
  editing: FacilityTypeRow | null;
  iconKeys: string[];
  categories: string[];
  mapFilterCategories: FacilityTypeMapFilterCategory[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [code, setCode] = useState(editing?.code ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [category, setCategory] = useState(editing?.category ?? "other");
  const [iconKey, setIconKey] = useState(editing?.iconKey ?? "generic");
  const [interval, setInterval] = useState(
    editing?.verificationIntervalDays == null ? "" : String(editing.verificationIntervalDays),
  );
  const [mapFilterCategoryId, setMapFilterCategoryId] = useState(editing?.mapFilterCategoryId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const codeOk = /^[a-z][a-z0-9_]*$/.test(code.trim().toLowerCase());
  const intervalOk = interval.trim() === "" || /^\d{1,4}$/.test(interval.trim());
  const ready = name.trim().length > 0 && (editing !== null || codeOk) && intervalOk && mapFilterCategoryId.length > 0;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const days = interval.trim() === "" ? null : Number(interval.trim());
      if (editing) {
        await admin.updateFacilityType(editing.id, {
          name: name.trim(),
          category,
          iconKey: iconKey || null,
          verificationIntervalDays: days,
          mapFilterCategoryId,
        });
        onSaved(`已保存「${name.trim()}」`);
      } else {
        await admin.createFacilityType({
          code: code.trim().toLowerCase(),
          name: name.trim(),
          category,
          iconKey: iconKey || null,
          verificationIntervalDays: days,
          mapFilterCategoryId,
        });
        onSaved(`已新增类型「${name.trim()}」`);
      }
      onClose();
    } catch (err) {
      setError(typeError(err, editing ? "保存失败" : "新增失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={editing ? `编辑类型 · ${editing.name}` : "新增设施类型"}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="名称"
          onChange={setName}
          placeholder="如 充电桩"
          value={name}
        />
        <Field
          disabled={editing !== null}
          label="英文编码"
          onChange={(value) => setCode(value.toLowerCase())}
          placeholder="如 charging_station"
          value={code}
        />
        <SelectField
          label="分类"
          onChange={setCategory}
          options={categories.map((key) => ({ value: key, label: categoryLabel(key) }))}
          value={category}
        />
        <Field
          label="建议复核间隔（天，可留空）"
          onChange={setInterval}
          placeholder="如 90"
          value={interval}
        />
        <SelectField
          label="地图分类"
          onChange={setMapFilterCategoryId}
          options={mapFilterCategories
            .filter((item) => editing !== null || item.active)
            .map((item) => ({ value: item.id, label: item.active ? item.label : `${item.label}（已停用）` }))}
          placeholder="选择地图分类"
          value={mapFilterCategoryId}
        />
      </div>
      <div className="mt-4 max-w-lg">
        <IconChooser iconKeys={iconKeys} onChange={setIconKey} value={iconKey} />
      </div>
      {editing ? (
        <p className="mt-3 text-label text-sub">
          英文编码是既有点位和已发布数据共用的稳定标识，建立后不再改动。需要换编码时请新增一个类型，再把这个停用。
        </p>
      ) : (
        <p className="mt-3 text-label text-sub">
          名称给所有人看，英文编码用于系统内部关联，只能用小写字母、数字和下划线，建立后不可修改。
        </p>
      )}
      {!editing && code.trim() && !codeOk ? (
        <p className="mt-2 text-aux text-warning">英文编码只能用小写字母、数字和下划线，并以字母开头。</p>
      ) : null}
      {!intervalOk ? <p className="mt-2 text-aux text-warning">复核间隔请填写整天数。</p> : null}
      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      <div className="mt-4 flex gap-2">
        <PrimaryButton disabled={!ready || busy} onClick={submit}>
          {busy ? "提交中…" : editing ? "保存修改" : "创建类型"}
        </PrimaryButton>
        <GhostButton disabled={busy} onClick={onClose}>
          取消
        </GhostButton>
      </div>
    </Panel>
  );
}

/** 一个类型下的点位明细：楼宇 + 楼层 + 点位名，点进去到设施编辑页。 */
function InstanceList({ instances, canEdit }: { instances: FacilityTypeInstanceRow[]; canEdit: boolean }) {
  if (!instances.length) {
    return (
      <div className="px-4 pb-4">
        <EmptyState label="这个类型下还没有点位" />
      </div>
    );
  }
  return (
    <div className="px-4 pb-4">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-label text-sub">
            <th className="px-3 pb-2 pt-1 font-medium">点位名称</th>
            <th className="px-3 pb-2 pt-1 font-medium">所在楼宇</th>
            <th className="px-3 pb-2 pt-1 font-medium">楼层 / 房间</th>
            <th className="px-3 pb-2 pt-1 font-medium">使用状态</th>
            <th className="px-3 pb-2 pt-1 text-right font-medium" />
          </tr>
        </thead>
        <tbody>
          {instances.map((instance) => (
            <tr className="border-t border-line" key={instance.id}>
              <td className="px-3 py-2.5 text-body text-ink">{instance.displayName}</td>
              <td className="px-3 py-2.5 text-aux text-sub">{instance.placeName ?? "未关联楼宇"}</td>
              <td className="px-3 py-2.5 text-aux text-sub">
                {[instance.floorName ?? instance.floorLevelCode, instance.spaceName].filter(Boolean).join(" · ") || "—"}
              </td>
              <td className="px-3 py-2.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={instance.lifecycleStatus === "active" ? "ok" : "neutral"}>
                    {LIFECYCLE_LABELS[instance.lifecycleStatus] ?? instance.lifecycleStatus}
                  </Pill>
                  <span className="text-label text-sub">
                    {OPERATIONAL_LABELS[instance.operationalStatus] ?? "状态未知"}
                  </span>
                </span>
              </td>
              <td className="px-3 py-2.5 text-right">
                {canEdit ? (
                  <Link
                    className="text-aux font-medium text-primary hover:underline"
                    to={`/admin/content/facilities/${instance.id}`}
                  >
                    去编辑
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TypeCard({
  type,
  canEdit,
  onEdit,
  onChanged,
}: {
  type: FacilityTypeRow;
  canEdit: boolean;
  onEdit: () => void;
  onChanged: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = type.status !== "disabled";
  const removable = type.instanceCount === 0 && type.collectionReferenceCount === 0;

  async function toggleStatus() {
    setBusy(true);
    setError("");
    try {
      await admin.updateFacilityType(type.id, { status: active ? "disabled" : "active" });
      onChanged(active ? `已停用「${type.name}」，新建设施和采集时不再出现这个选项` : `已重新启用「${type.name}」`);
    } catch (err) {
      setError(typeError(err, "操作失败"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await admin.deleteFacilityType(type.id);
      onChanged(`已删除「${type.name}」`);
    } catch (err) {
      setError(typeError(err, "删除失败"));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl bg-surface">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <button
          aria-expanded={open}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sub hover:bg-page hover:text-ink"
          onClick={() => setOpen((value) => !value)}
          title={open ? "收起点位" : "展开点位"}
          type="button"
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <IconPreview iconKey={type.iconKey} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-body font-medium text-ink">
            {type.name}
            {active ? null : <Pill tone="neutral">已停用</Pill>}
          </p>
          <p className="mt-0.5 text-label text-sub">
            {categoryLabel(type.category)} · 地图分类：{type.mapFilterLabel} · 图标：{facilityIconKeyLabel(type.iconKey ?? "generic")}
            {type.verificationIntervalDays ? ` · 建议每 ${type.verificationIntervalDays} 天复核` : ""}
          </p>
        </div>
        <button
          className="shrink-0 rounded-lg px-2.5 py-1 text-aux text-sub hover:bg-page hover:text-ink"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {type.instanceCount} 个点位
        </button>
        {canEdit ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
              disabled={busy}
              onClick={onEdit}
              type="button"
            >
              <Pencil size={13} />
              编辑
            </button>
            <button
              className={`h-8 rounded-lg border px-3 text-aux font-medium disabled:opacity-40 ${
                active ? "border-error/40 text-error" : "border-line text-ink"
              }`}
              disabled={busy}
              onClick={() => void toggleStatus()}
              title={active ? "停用后不再作为新建设施与采集的可选项，已有点位不受影响" : "重新作为可选项"}
              type="button"
            >
              {active ? "停用" : "启用"}
            </button>
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-error/40 px-3 text-aux font-medium text-error disabled:opacity-40"
              disabled={busy || !removable}
              onClick={() => setConfirmDelete(true)}
              title={removable ? "彻底删除这个类型" : "这个类型仍被点位或采集记录引用，只能停用"}
              type="button"
            >
              <Trash2 size={13} />
              删除
            </button>
          </div>
        ) : null}
      </div>

      {error ? <div className="px-4 pb-3"><ErrorBanner message={error} /></div> : null}

      {confirmDelete ? (
        <div className="mx-4 mb-3 rounded-lg bg-error-bg px-4 py-3">
          <p className="text-body font-medium text-error">确认删除「{type.name}」？删除后不可恢复。</p>
          <div className="mt-2.5 flex gap-2">
            <button
              className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
              disabled={busy}
              onClick={() => void remove()}
              type="button"
            >
              {busy ? "删除中…" : "确认删除"}
            </button>
            <button
              className="h-8 rounded-lg border border-line bg-surface px-3 text-aux font-medium text-ink"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
              type="button"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {open ? <InstanceList canEdit={canEdit} instances={type.instances} /> : null}
    </section>
  );
}

export function FacilityTypesPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("write:content");
  const { state, reload } = useAsyncData((signal) => admin.listFacilityTypes(signal), []);
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FacilityTypeRow | null>(null);
  const [notice, setNotice] = useState("");

  if (state.status === "loading") return <LoadingState label="加载设施类型…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;

  const countOf = (key: string) => {
    if (key === "all") return data.items.length;
    if (key === "active") return data.items.filter((t) => t.status !== "disabled").length;
    if (key === "disabled") return data.items.filter((t) => t.status === "disabled").length;
    return data.items.filter((t) => t.instanceCount === 0 && t.collectionReferenceCount === 0).length;
  };
  const visible = data.items.filter((type) => {
    if (filter === "active") return type.status !== "disabled";
    if (filter === "disabled") return type.status === "disabled";
    if (filter === "empty") return type.instanceCount === 0 && type.collectionReferenceCount === 0;
    return true;
  });

  const filters = [
    { key: "all", label: "全部" },
    { key: "active", label: "启用中" },
    { key: "disabled", label: "已停用" },
    { key: "empty", label: "可删除" },
  ];

  function afterChange(message: string) {
    setNotice(message);
    reload();
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <p className="rounded-lg bg-success-bg px-4 py-3 text-body font-medium text-success">{notice}</p>
      ) : null}

      {creating || editing ? (
        <TypeForm
          categories={data.categories}
          editing={editing}
          iconKeys={data.iconKeys}
          mapFilterCategories={data.mapFilterCategories}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={afterChange}
        />
      ) : null}

      <Panel
        action={
          <div className="flex flex-wrap items-center gap-2">
            {filters.map((item) => (
              <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
                {item.label} {countOf(item.key)}
              </Chip>
            ))}
            {canEdit && !creating && !editing ? (
              <PrimaryButton className="h-8" onClick={() => setCreating(true)}>
                <Plus size={15} />
                新增类型
              </PrimaryButton>
            ) : null}
          </div>
        }
        title={
          <span className="inline-flex items-center gap-2">
            <Tags size={16} className="text-sub" />
            设施类型
          </span>
        }
      >
        <p className="text-aux leading-relaxed text-sub">
          这里维护地图上设施的大类。停用一个类型后，它不再出现在新建设施和志愿者采集的可选项里，
          但已经录入的点位照常展示，历史数据不受影响。只有一个点位都没挂的类型才能彻底删除。
        </p>
      </Panel>

      {visible.length === 0 ? (
        <EmptyState label="没有符合条件的设施类型" />
      ) : (
        <div className="space-y-2.5">
          {visible.map((type) => (
            <TypeCard
              canEdit={canEdit}
              key={type.id}
              onChanged={afterChange}
              onEdit={() => {
                setCreating(false);
                setNotice("");
                setEditing(type);
              }}
              type={type}
            />
          ))}
        </div>
      )}
    </div>
  );
}
