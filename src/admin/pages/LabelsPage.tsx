import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Pencil, Plus, Store, Tags, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type {
  FacilityTypeInstanceRow,
  FacilityTypeRow,
  MapFilterMemberRow,
  MapFilterPlaceEntryRow,
  MapFilterRow,
  PlaceKindRow,
} from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import { facilityIconByKey, facilityIconKeyLabel } from "../../lib/facilityIcons";
import { useAuth } from "../AuthContext";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SelectField,
  errorMessage,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// 标签管理：一个页面管完前台地图上那排筛选按钮，以及挂在每个按钮下面的成员。
//
// 这里只有一套词：**标签**。标签是父级，成员分三种——地点类型、设施类型、商户。
// 每个地点类型 / 设施类型只能归属一个标签（数据库有唯一索引兜着），所以「归属」
// 这件事只在标签卡片里改：加成员、移到别的标签、移出。类型自身的属性（名称、图标、
// 复核间隔）在下面两个区里改，那里不再重复给一个「归属」下拉，避免同一件事两个入口。
//
// 唯一的例外是**新建**设施类型：服务端要求建立时就指定标签（否则触发器会拒绝写入），
// 所以新建表单里有一个标签选择，建完之后就只能从标签卡片里搬。
// ---------------------------------------------------------------------------

const ERROR_TEXT: Record<string, string> = {
  code_taken: "这个英文编码已经被别的设施类型占用了，换一个再试。",
  invalid_code: "英文编码只能用小写字母、数字和下划线，并以字母开头。",
  code_immutable: "已有设施类型的英文编码不能修改。要换编码请新建一个，再把旧的停用。",
  unsupported_icon_key: "选择的图标不在支持范围内，请重新选择。",
  facility_type_in_use: "这个设施类型仍被点位或采集记录引用，不能删除。可以先停用它。",
  inactive_map_filter: "启用中的设施类型必须归属一个启用中的标签。",
  map_filter_in_use: "这个标签仍承载使用中的内容，当前操作无法完成。",
  place_kind_in_use: "这个地点类型下还有地点，不能删除。",
  validation_error: "填写的内容不完整或不正确，请检查后重试。",
  forbidden: "当前账号没有维护标签的权限。",
  unauthorized: "登录状态已失效，请重新登录。",
  not_found: "这条记录不存在，可能已被其他人改动，刷新后再试。",
};

function labelError(err: unknown, defaultMessage: string): string {
  if (err instanceof ApiError) return ERROR_TEXT[err.code] ?? defaultMessage;
  return errorMessage(err, defaultMessage);
}

const LIFECYCLE_LABELS: Record<string, string> = {
  planned: "筹备中",
  active: "使用中",
  retired: "已撤除",
};

const OPERATIONAL_LABELS: Record<string, string> = {
  available: "可用",
  partially_available: "部分可用",
  unavailable: "不可用",
  unknown: "状态未知",
};

/**
 * 设施类型的显示开关。
 *
 * `campusDefault` 是「不选任何筛选时，校区图上直接画出它的图钉」。种子数据里它一律
 * 是 false，于是新建的楼外设施在地图上永远看不到——而这件事此前后台无法修改，管理员
 * 只能干等。fallback 与服务端 DEFAULT_VISIBILITY_POLICY 一致：策略里缺这个键时按
 * 默认值显示，别把「没设置」画成「已关闭」。
 */
const VISIBILITY_SWITCHES = [
  {
    key: "campusDefault" as const,
    label: "校区图默认显示",
    fallback: false,
    hint: "关掉时，只有搜到它或选中它所属标签才会出现在地图上",
  },
  {
    key: "searchable" as const,
    label: "可被搜索",
    fallback: true,
    hint: "关掉后搜索结果里不再出现这个类型的点位",
  },
  {
    key: "filterable" as const,
    label: "可被筛选",
    fallback: true,
    hint: "关掉后点它所属的标签也不会把它筛出来",
  },
  {
    key: "showWhenUnavailable" as const,
    label: "不可用时仍显示",
    fallback: true,
    hint: "关掉后，实时状态为「不可用」的点位会从地图上隐去",
  },
];

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

/** 一个设施类型下的点位明细：楼宇 + 楼层 + 点位名，点进去到设施编辑页。 */
function InstanceList({ instances, canEdit }: { instances: FacilityTypeInstanceRow[]; canEdit: boolean }) {
  if (!instances.length) {
    return <div className="px-4 pb-4"><EmptyState label="这个设施类型下还没有点位" /></div>;
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
                  <Link className="text-aux font-medium text-primary hover:underline" to={`/admin/content/facilities/${instance.id}`}>
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

/** 一个地点类型成员下挂着的地点清单，点进去到地点编辑页。 */
function PlaceEntryList({ entries, canEdit }: { entries: MapFilterPlaceEntryRow[]; canEdit: boolean }) {
  return (
    <table className="mt-2 w-full border-collapse">
      <thead>
        <tr className="text-left text-label text-sub">
          <th className="px-3 pb-1.5 font-medium">名称</th>
          <th className="px-3 pb-1.5 font-medium">校区</th>
          <th className="px-3 pb-1.5 font-medium">形态</th>
          <th className="px-3 pb-1.5 font-medium">状态</th>
          <th className="px-3 pb-1.5 text-right font-medium" />
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr className="border-t border-line" key={entry.id}>
            <td className="px-3 py-2 text-body text-ink">{entry.displayName}</td>
            <td className="px-3 py-2 text-aux text-sub">{entry.campusName ?? "未指定校区"}</td>
            <td className="px-3 py-2 text-aux text-sub">{entry.isBuilding ? "楼宇" : "楼外地点"}</td>
            <td className="px-3 py-2">
              <span className="flex flex-wrap items-center gap-1.5">
                <Pill tone={entry.lifecycleStatus === "active" ? "ok" : "neutral"}>
                  {LIFECYCLE_LABELS[entry.lifecycleStatus] ?? entry.lifecycleStatus}
                </Pill>
                {entry.editorialStatus === null ? (
                  <span className="text-label text-sub">尚无已发布修订</span>
                ) : null}
              </span>
            </td>
            <td className="px-3 py-2 text-right">
              {canEdit ? (
                <Link className="text-aux font-medium text-primary hover:underline" to={`/admin/content/places/${entry.id}`}>
                  去编辑
                </Link>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 标签卡片里的一个成员：归属对象 + 换标签下拉 + 移出，地点类型还能展开看成员。
 *
 * 展开这件事只有地点类型有：设施类型的点位明细在下面「设施类型」区里按类型展开
 * （同一份数据不做两个入口），商户是整类纳入，没有可枚举的对象。
 */
function MemberChip({
  member,
  labels,
  busy,
  canEdit,
  facilityTypeById,
  onMove,
  onRemove,
}: {
  member: MapFilterMemberRow;
  labels: MapFilterRow[];
  busy: boolean;
  canEdit: boolean;
  facilityTypeById: Map<string, FacilityTypeRow>;
  onMove: (memberId: string, categoryId: string) => void;
  onRemove: (memberId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const facilityType = member.facilityTypeId === null ? null : facilityTypeById.get(member.facilityTypeId) ?? null;
  const kindTone = member.includesMerchants ? "商户" : member.placeKindId !== null ? "地点类型" : "设施类型";
  const expandable = member.placeKindId !== null;
  return (
    <div className="w-full rounded-xl bg-page px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-aux">
        {expandable ? (
          <button
            aria-expanded={open}
            aria-label={open ? `收起「${member.targetLabel}」下的地点` : `展开「${member.targetLabel}」下的地点`}
            className="grid h-6 w-6 place-items-center rounded-full text-sub hover:bg-line disabled:opacity-40"
            disabled={member.entries.length === 0}
            onClick={() => setOpen((value) => !value)}
            title={member.entries.length === 0 ? "这个类型下还没有地点" : open ? "收起" : "展开看成员"}
            type="button"
          >
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : null}
        {member.includesMerchants ? (
          <Store className="text-sub" size={14} />
        ) : facilityType ? (
          (() => {
            const Icon = facilityIconByKey(facilityType.iconKey);
            return <Icon className="text-sub" size={14} />;
          })()
        ) : null}
        <span className="font-medium text-ink">{member.targetLabel}</span>
        <span className="text-sub">{kindTone}</span>
        <span className="text-sub">
          {member.includesMerchants
            ? `${member.usageCount} 个商户`
            : member.placeKindId !== null
              ? `${member.usageCount} 个地点`
              : `${member.usageCount} 个点位`}
        </span>
        <span className="flex-1" />
        {canEdit ? (
          <>
            <select
              aria-label={`把「${member.targetLabel}」移到别的标签`}
              className="rounded border border-line bg-surface px-1 py-0.5"
              disabled={busy}
              onChange={(event) => onMove(member.id, event.target.value)}
              value={member.categoryId}
            >
              {labels.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <button
              aria-label={`把「${member.targetLabel}」移出这个标签`}
              className="grid h-6 w-6 place-items-center rounded-full text-sub hover:bg-line"
              disabled={busy}
              onClick={() => onRemove(member.id)}
              type="button"
            >
              <X size={13} />
            </button>
          </>
        ) : null}
      </div>
      {open && member.entries.length > 0 ? <PlaceEntryList canEdit={canEdit} entries={member.entries} /> : null}
    </div>
  );
}

type MemberTarget = "placeKind" | "facilityType" | "merchants";

/** 新建 / 编辑设施类型。editing 为空即新建（新建时必须选标签）。 */
function FacilityTypeForm({
  editing,
  iconKeys,
  labels,
  onClose,
  onSaved,
}: {
  editing: FacilityTypeRow | null;
  iconKeys: string[];
  labels: MapFilterRow[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [code, setCode] = useState(editing?.code ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [iconKey, setIconKey] = useState(editing?.iconKey ?? "generic");
  const [interval, setInterval] = useState(
    editing?.verificationIntervalDays == null ? "" : String(editing.verificationIntervalDays),
  );
  const [labelId, setLabelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const codeOk = /^[a-z][a-z0-9_]*$/.test(code.trim().toLowerCase());
  const intervalOk = interval.trim() === "" || /^\d{1,4}$/.test(interval.trim());
  const ready = name.trim().length > 0
    && (editing !== null || (codeOk && labelId.length > 0))
    && intervalOk;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const days = interval.trim() === "" ? null : Number(interval.trim());
      if (editing) {
        // 归属不在这里改：标签卡片才是唯一入口，所以不传 mapFilterCategoryId。
        await admin.updateFacilityType(editing.id, {
          name: name.trim(),
          iconKey: iconKey || null,
          verificationIntervalDays: days,
        });
        onSaved(`已保存设施类型「${name.trim()}」`);
      } else {
        await admin.createFacilityType({
          code: code.trim().toLowerCase(),
          name: name.trim(),
          iconKey: iconKey || null,
          verificationIntervalDays: days,
          mapFilterCategoryId: labelId,
        });
        onSaved(`已新增设施类型「${name.trim()}」`);
      }
      onClose();
    } catch (err) {
      setError(labelError(err, editing ? "保存失败" : "新增失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={editing ? `编辑设施类型 · ${editing.name}` : "新增设施类型"}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="名称" onChange={setName} placeholder="如 充电桩" value={name} />
        <Field
          disabled={editing !== null}
          label="英文编码"
          onChange={(value) => setCode(value.toLowerCase())}
          placeholder="如 charging_station"
          value={code}
        />
        <Field label="建议复核间隔（天，可留空）" onChange={setInterval} placeholder="如 90" value={interval} />
        {editing ? (
          <div>
            <span className="mb-1.5 block text-label text-sub">归属标签</span>
            <p className="pt-1.5 text-body text-ink">
              {editing.mapFilterLabel}
              {editing.mapFilterActive ? null : <span className="ml-1.5 text-sub">（已停用）</span>}
            </p>
            <p className="mt-1 text-label text-sub">要换标签，请在上面的标签卡片里把它拖到别的标签下。</p>
          </div>
        ) : (
          <SelectField
            label="归属标签"
            onChange={setLabelId}
            options={labels.filter((item) => item.active).map((item) => ({ value: item.id, label: item.label }))}
            placeholder="选择标签"
            value={labelId}
          />
        )}
      </div>
      <div className="mt-4 max-w-lg">
        <IconChooser iconKeys={iconKeys} onChange={setIconKey} value={iconKey} />
      </div>
      <p className="mt-3 text-label text-sub">
        {editing
          ? "英文编码是既有点位和已发布数据共用的稳定标识，建立后不再改动。需要换编码时请新增一个类型，再把这个停用。"
          : "名称给所有人看，英文编码用于系统内部关联，只能用小写字母、数字和下划线，建立后不可修改。"}
      </p>
      {!editing && code.trim() && !codeOk ? (
        <p className="mt-2 text-aux text-warning">英文编码只能用小写字母、数字和下划线，并以字母开头。</p>
      ) : null}
      {!intervalOk ? <p className="mt-2 text-aux text-warning">复核间隔请填写整天数。</p> : null}
      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      <div className="mt-4 flex gap-2">
        <PrimaryButton disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "提交中…" : editing ? "保存修改" : "创建设施类型"}
        </PrimaryButton>
        <GhostButton disabled={busy} onClick={onClose}>取消</GhostButton>
      </div>
    </Panel>
  );
}

/** 一个设施类型在列表里的一行，可展开看点位。 */
function FacilityTypeRowCard({
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

  async function run(action: () => Promise<unknown>, message: string, failure: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      onChanged(message);
    } catch (err) {
      setError(labelError(err, failure));
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
            <code>{type.code}</code> · 标签：{type.mapFilterLabel}
            {type.mapFilterActive ? "" : "（已停用）"}
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
            <GhostButton disabled={busy} onClick={onEdit}><Pencil size={13} />编辑</GhostButton>
            <GhostButton
              danger={active}
              disabled={busy}
              onClick={() => void run(
                () => admin.updateFacilityType(type.id, { status: active ? "disabled" : "active" }),
                active ? `已停用「${type.name}」，新建设施和采集时不再出现这个选项` : `已重新启用「${type.name}」`,
                "操作失败",
              )}
            >
              {active ? "停用" : "启用"}
            </GhostButton>
            <GhostButton
              danger
              disabled={busy || !removable}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} />删除
            </GhostButton>
          </div>
        ) : null}
      </div>

      {error ? <div className="px-4 pb-3"><ErrorBanner message={error} /></div> : null}

      {/* 显示开关。放在这里而不是编辑弹窗里，是因为「点位加了但地图上看不到」时，
          第一个要查的就是它，得一眼能看见当前是开还是关。 */}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5">
          <span className="text-label text-sub">显示</span>
          {VISIBILITY_SWITCHES.map((item) => {
            const on = type.visibilityPolicy[item.key] ?? item.fallback;
            return (
              <GhostButton
                disabled={busy}
                key={item.key}
                onClick={() => void run(
                  () => admin.updateFacilityType(type.id, { visibilityPolicy: { [item.key]: !on } }),
                  on ? `已关闭「${type.name}」的${item.label}` : `已打开「${type.name}」的${item.label}`,
                  "修改显示开关失败",
                )}
                title={item.hint}
              >
                {on ? <Eye size={13} /> : <EyeOff size={13} />}
                {item.label}
              </GhostButton>
            );
          })}
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="mx-4 mb-3 rounded-lg bg-error-bg px-4 py-3">
          <p className="text-body font-medium text-error">确认删除「{type.name}」？删除后不可恢复。</p>
          <div className="mt-2.5 flex gap-2">
            <button
              className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
              disabled={busy}
              onClick={() => void run(() => admin.deleteFacilityType(type.id), `已删除「${type.name}」`, "删除失败")}
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

export function LabelsPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("write:content");
  const { state, reload } = useAsyncData(
    async (signal) => {
      const [filters, facilityTypes] = await Promise.all([
        admin.listMapFilters(signal),
        admin.listFacilityTypes(signal),
      ]);
      return { filters, facilityTypes };
    },
    [],
  );

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // 标签
  const [addingLabel, setAddingLabel] = useState(false);
  const [labelKey, setLabelKey] = useState("");
  const [labelName, setLabelName] = useState("");
  const [labelOrder, setLabelOrder] = useState("100");
  const [editingLabelId, setEditingLabelId] = useState("");
  const [editLabelName, setEditLabelName] = useState("");
  const [editLabelOrder, setEditLabelOrder] = useState("100");

  // 成员
  const [memberLabelId, setMemberLabelId] = useState("");
  const [memberTarget, setMemberTarget] = useState<MemberTarget>("placeKind");
  const [memberValue, setMemberValue] = useState("");

  // 地点类型
  const [addingKind, setAddingKind] = useState(false);
  const [kindId, setKindId] = useState("");
  const [kindName, setKindName] = useState("");
  const [kindOrder, setKindOrder] = useState("100");
  const [kindLabelId, setKindLabelId] = useState("");
  const [editingKindId, setEditingKindId] = useState("");
  const [editKindName, setEditKindName] = useState("");
  const [editKindOrder, setEditKindOrder] = useState("100");

  // 设施类型
  const [creatingType, setCreatingType] = useState(false);
  const [editingType, setEditingType] = useState<FacilityTypeRow | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");

  if (state.status === "loading") return <LoadingState label="加载标签…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const { filters: data, facilityTypes } = state.data!;

  const labels = data.items;
  const activeLabelOptions = labels.filter((item) => item.active).map((item) => ({ value: item.id, label: item.label }));
  const labelById = new Map(labels.map((item) => [item.id, item]));
  const facilityTypeById = new Map(facilityTypes.items.map((type) => [type.id, type]));
  const kindLabelName = (categoryId: string | null): string => {
    if (categoryId === null) return "未归属";
    const label = labelById.get(categoryId);
    if (!label) throw new Error(`地点类型引用了不存在的标签：${categoryId}`);
    return label.label;
  };
  const unassignedTargets = memberTarget === "placeKind"
    ? data.unassigned.placeKinds
    : memberTarget === "facilityType"
      ? data.unassigned.facilityTypes
      : [];

  const typeCountOf = (key: string) => {
    if (key === "all") return facilityTypes.items.length;
    if (key === "active") return facilityTypes.items.filter((t) => t.status !== "disabled").length;
    if (key === "disabled") return facilityTypes.items.filter((t) => t.status === "disabled").length;
    return facilityTypes.items.filter((t) => t.instanceCount === 0 && t.collectionReferenceCount === 0).length;
  };
  const visibleTypes = facilityTypes.items.filter((type) => {
    if (typeFilter === "active") return type.status !== "disabled";
    if (typeFilter === "disabled") return type.status === "disabled";
    if (typeFilter === "empty") return type.instanceCount === 0 && type.collectionReferenceCount === 0;
    return true;
  });

  async function mutate(action: () => Promise<unknown>, failureMessage: string, successMessage?: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      if (successMessage) setNotice(successMessage);
      reload();
    } catch (reason) {
      setError(labelError(reason, failureMessage));
    } finally {
      setBusy(false);
    }
  }

  function afterTypeChange(message: string) {
    setNotice(message);
    setError("");
    reload();
  }

  async function createLabel() {
    if (!labelKey.trim() || !labelName.trim()) {
      setError("请填写标签的键和名称");
      return;
    }
    await mutate(
      () => admin.createMapFilter({ key: labelKey.trim(), label: labelName.trim(), sortOrder: Number(labelOrder) }),
      "新增标签失败",
      `已新增标签「${labelName.trim()}」`,
    );
    setAddingLabel(false);
    setLabelKey("");
    setLabelName("");
  }

  async function addMember(categoryId: string) {
    if (memberTarget !== "merchants" && !memberValue) {
      setError("请选择要加入的成员");
      return;
    }
    const body = memberTarget === "placeKind"
      ? { placeKindId: memberValue }
      : memberTarget === "facilityType"
        ? { facilityTypeId: memberValue }
        : { includesMerchants: true as const };
    await mutate(() => admin.createMapFilterMember(categoryId, body), "添加成员失败", "已添加成员");
    setMemberLabelId("");
    setMemberValue("");
  }

  async function createKind() {
    if (!kindId.trim() || !kindName.trim() || !kindLabelId) {
      setError("请填写地点类型的 ID、名称，并选择归属标签");
      return;
    }
    await mutate(
      () => admin.createPlaceKind({
        id: kindId.trim(),
        name: kindName.trim(),
        sortOrder: Number(kindOrder),
        isSearchable: true,
        categoryId: kindLabelId,
      }),
      "新增地点类型失败",
      `已新增地点类型「${kindName.trim()}」`,
    );
    setAddingKind(false);
    setKindId("");
    setKindName("");
    setKindLabelId("");
  }

  return (
    <div className="space-y-4">
      {notice ? <p className="rounded-lg bg-success-bg px-4 py-3 text-body font-medium text-success">{notice}</p> : null}
      <ErrorBanner message={error} />

      <Panel
        title={<span className="inline-flex items-center gap-2"><Tags className="text-sub" size={16} />标签是什么</span>}
      >
        <p className="text-aux leading-relaxed text-sub">
          标签就是前台地图上那一排可以点的筛选按钮。每个标签下面挂着它包含的东西——
          <span className="text-ink">地点类型</span>（如「建筑」「图书馆」）、
          <span className="text-ink">设施类型</span>（如「打印机」「饮水点」），
          以及要不要把<span className="text-ink">商户</span>整类算进来。
          一个地点类型或设施类型只能归属一个标签，所以「教学楼」不会同时把食堂和图书馆算进去。
          <br />
          归属只在下面的标签卡片里改。类型自己的名称、图标、复核间隔在「设施类型」「地点类型」两个区里改。
        </p>
      </Panel>

      {/* 标签（父级） */}
      <Panel
        title="标签"
        action={canEdit ? <GhostButton onClick={() => setAddingLabel((value) => !value)}><Plus size={14} />新增标签</GhostButton> : undefined}
      >
        <div className="space-y-4">
          {addingLabel ? (
            <div className="grid grid-cols-[1fr_1fr_120px_auto] items-end gap-3 rounded-xl bg-page p-4">
              <Field label="键（英文，前台用）" onChange={setLabelKey} placeholder="dining" value={labelKey} />
              <Field label="名称" onChange={setLabelName} placeholder="餐饮" value={labelName} />
              <Field label="排序" onChange={setLabelOrder} type="number" value={labelOrder} />
              <div className="flex gap-2">
                <PrimaryButton disabled={busy} onClick={() => void createLabel()}>保存</PrimaryButton>
                <GhostButton onClick={() => setAddingLabel(false)}>取消</GhostButton>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {labels.map((label) => (
              <div className="rounded-xl border border-line p-4" key={label.id}>
                {editingLabelId === label.id ? (
                  <div className="grid grid-cols-[1fr_120px_auto] items-end gap-3">
                    <Field label="名称" onChange={setEditLabelName} value={editLabelName} />
                    <Field label="排序" onChange={setEditLabelOrder} type="number" value={editLabelOrder} />
                    <div className="flex gap-2">
                      <GhostButton
                        disabled={busy}
                        onClick={() => void mutate(async () => {
                          await admin.updateMapFilter(label.id, { label: editLabelName.trim(), sortOrder: Number(editLabelOrder) });
                          setEditingLabelId("");
                        }, "保存标签失败", "已保存标签")}
                      >
                        <Check size={14} />保存
                      </GhostButton>
                      <GhostButton onClick={() => setEditingLabelId("")}><X size={14} /></GhostButton>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-semibold text-ink">{label.label}</span>
                    <code className="text-aux text-sub">{label.key}</code>
                    <span className="text-aux text-sub">排序 {label.sortOrder}</span>
                    <span className="flex-1" />
                    <Pill tone={label.active ? "ok" : "neutral"}>{label.active ? "启用" : "停用"}</Pill>
                    {canEdit ? (
                      <>
                        <GhostButton onClick={() => { setEditingLabelId(label.id); setEditLabelName(label.label); setEditLabelOrder(String(label.sortOrder)); }}>
                          <Pencil size={14} />编辑
                        </GhostButton>
                        <GhostButton
                          disabled={busy}
                          onClick={() => void mutate(
                            () => admin.updateMapFilter(label.id, { active: !label.active }),
                            "更新状态失败",
                            label.active ? `已停用标签「${label.label}」` : `已启用标签「${label.label}」`,
                          )}
                        >
                          {label.active ? "停用" : "启用"}
                        </GhostButton>
                        <GhostButton
                          danger
                          disabled={busy || label.members.length > 0}
                          onClick={() => void mutate(() => admin.deleteMapFilter(label.id), "删除标签失败", `已删除标签「${label.label}」`)}
                        >
                          <Trash2 size={14} />删除
                        </GhostButton>
                      </>
                    ) : null}
                  </div>
                )}

                {/* 成员现在每行一条：地点类型能展开出下面挂着的地点，横排胶囊放不下。 */}
                <div className="mt-3 space-y-2">
                  {label.members.map((member) => (
                    <MemberChip
                      busy={busy}
                      canEdit={canEdit}
                      facilityTypeById={facilityTypeById}
                      key={member.id}
                      labels={labels}
                      member={member}
                      onMove={(memberId, categoryId) => void mutate(
                        () => admin.updateMapFilterMember(memberId, { categoryId }),
                        "移动成员失败",
                        "已移动成员",
                      )}
                      onRemove={(memberId) => void mutate(
                        () => admin.deleteMapFilterMember(memberId),
                        "移出成员失败",
                        "已移出成员",
                      )}
                    />
                  ))}
                  {label.members.length === 0 ? (
                    <span className="text-aux text-sub">这个标签还没有成员，前台不会显示它。</span>
                  ) : null}
                </div>

                {canEdit ? (
                  memberLabelId === label.id ? (
                    <div className="mt-3 grid grid-cols-[140px_1fr_auto] items-end gap-2 rounded-lg bg-page p-3">
                      <SelectField
                        label="成员类型"
                        onChange={(value) => {
                          if (value !== "placeKind" && value !== "facilityType" && value !== "merchants") {
                            throw new Error(`未知的成员类型：${value}`);
                          }
                          setMemberTarget(value);
                          setMemberValue("");
                        }}
                        options={[
                          { value: "placeKind", label: "地点类型" },
                          { value: "facilityType", label: "设施类型" },
                          { value: "merchants", label: "商户" },
                        ]}
                        value={memberTarget}
                      />
                      {memberTarget === "merchants" ? (
                        <div className="pb-2 text-body text-sub">把商户整类纳入这个标签</div>
                      ) : (
                        <SelectField
                          label="成员"
                          onChange={setMemberValue}
                          options={unassignedTargets.map((row) => ({ value: row.id, label: row.name }))}
                          placeholder={unassignedTargets.length ? "选择成员" : "没有未归属的成员了"}
                          value={memberValue}
                        />
                      )}
                      <div className="flex gap-2">
                        <PrimaryButton
                          disabled={busy || (memberTarget === "merchants" && !data.unassigned.includesMerchants)}
                          onClick={() => void addMember(label.id)}
                        >
                          添加
                        </PrimaryButton>
                        <GhostButton onClick={() => setMemberLabelId("")}>取消</GhostButton>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="mt-3 text-aux font-medium text-primary"
                      onClick={() => { setMemberLabelId(label.id); setMemberValue(""); }}
                      type="button"
                    >
                      + 添加成员
                    </button>
                  )
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {/* 地点类型 */}
      <Panel
        title="地点类型"
        action={canEdit ? <GhostButton onClick={() => setAddingKind((value) => !value)}><Plus size={14} />新增地点类型</GhostButton> : undefined}
      >
        <div className="space-y-3">
          <p className="text-aux leading-relaxed text-sub">
            地点类型决定一个地点在前台归到哪个标签下，也决定它在搜索结果里显示成什么。
          </p>
          {addingKind ? (
            <div className="grid grid-cols-[1fr_1fr_100px_1fr_auto] items-end gap-3 rounded-xl bg-page p-4">
              <Field label="ID（英文）" onChange={setKindId} placeholder="library" value={kindId} />
              <Field label="名称" onChange={setKindName} placeholder="图书馆" value={kindName} />
              <Field label="排序" onChange={setKindOrder} type="number" value={kindOrder} />
              <SelectField label="归属标签" onChange={setKindLabelId} options={activeLabelOptions} placeholder="选择标签" value={kindLabelId} />
              <div className="flex gap-2">
                <PrimaryButton disabled={busy || !kindLabelId} onClick={() => void createKind()}>保存</PrimaryButton>
                <GhostButton onClick={() => setAddingKind(false)}>取消</GhostButton>
              </div>
            </div>
          ) : null}
          <div className="divide-y divide-line">
            {data.placeKinds.map((kind: PlaceKindRow) => editingKindId === kind.id ? (
              <div className="grid grid-cols-[1fr_120px_auto] items-end gap-3 py-3" key={kind.id}>
                <Field label="名称" onChange={setEditKindName} value={editKindName} />
                <Field label="排序" onChange={setEditKindOrder} type="number" value={editKindOrder} />
                <div className="flex gap-2">
                  <GhostButton
                    disabled={busy}
                    onClick={() => void mutate(async () => {
                      await admin.updatePlaceKind(kind.id, { name: editKindName.trim(), sortOrder: Number(editKindOrder) });
                      setEditingKindId("");
                    }, "保存地点类型失败", "已保存地点类型")}
                  >
                    <Check size={14} />保存
                  </GhostButton>
                  <GhostButton onClick={() => setEditingKindId("")}><X size={14} /></GhostButton>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 py-3" key={kind.id}>
                <span className="w-40 font-medium text-ink">{kind.name}</span>
                <code className="w-32 text-aux text-sub">{kind.id}</code>
                <span className="flex-1 text-aux text-sub">
                  排序 {kind.sortOrder} · {kind.placeCount} 个地点 · 标签：{kindLabelName(kind.categoryId)}
                </span>
                {canEdit ? (
                  <>
                    <GhostButton onClick={() => { setEditingKindId(kind.id); setEditKindName(kind.name); setEditKindOrder(String(kind.sortOrder)); }}>
                      <Pencil size={14} />编辑
                    </GhostButton>
                    <GhostButton
                      danger
                      disabled={busy || kind.placeCount > 0}
                      onClick={() => void mutate(() => admin.deletePlaceKind(kind.id), "删除地点类型失败", `已删除地点类型「${kind.name}」`)}
                    >
                      <Trash2 size={14} />删除
                    </GhostButton>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {/* 设施类型 */}
      {creatingType || editingType ? (
        <FacilityTypeForm
          editing={editingType}
          iconKeys={facilityTypes.iconKeys}
          labels={labels}
          onClose={() => { setCreatingType(false); setEditingType(null); }}
          onSaved={afterTypeChange}
        />
      ) : null}

      <Panel
        action={
          <div className="flex flex-wrap items-center gap-2">
            {[
              { key: "all", label: "全部" },
              { key: "active", label: "启用中" },
              { key: "disabled", label: "已停用" },
              { key: "empty", label: "可删除" },
            ].map((item) => (
              <Chip active={typeFilter === item.key} key={item.key} onClick={() => setTypeFilter(item.key)}>
                {item.label} {typeCountOf(item.key)}
              </Chip>
            ))}
            {canEdit && !creatingType && !editingType ? (
              <PrimaryButton className="h-8" onClick={() => setCreatingType(true)}>
                <Plus size={15} />新增设施类型
              </PrimaryButton>
            ) : null}
          </div>
        }
        title="设施类型"
      >
        <p className="text-aux leading-relaxed text-sub">
          设施类型是挂在楼里的具体品类：打印机、饮水点、电梯。停用一个类型后，它不再出现在新建设施和
          志愿者采集的可选项里，但已经录入的点位照常展示。只有一个点位都没挂、也没被采集记录引用的类型才能彻底删除。
        </p>
      </Panel>

      {visibleTypes.length === 0 ? (
        <EmptyState label="没有符合条件的设施类型" />
      ) : (
        <div className="space-y-2.5">
          {visibleTypes.map((type) => (
            <FacilityTypeRowCard
              canEdit={canEdit}
              key={type.id}
              onChanged={afterTypeChange}
              onEdit={() => { setCreatingType(false); setNotice(""); setEditingType(type); }}
              type={type}
            />
          ))}
        </div>
      )}

      {labels.some((label) => label.active && label.members.length === 0) ? (
        <InfoNote tone="warning">
          有启用中的标签还没有任何成员。发版校验会拒绝这种标签，请先给它加成员或把它停用。
        </InfoNote>
      ) : null}
    </div>
  );
}
