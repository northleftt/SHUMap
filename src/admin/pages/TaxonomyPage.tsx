import { ChevronDown, ChevronRight, Eye, EyeOff, Pencil, Plus, Store, Tags, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type {
  CustomFacilityIconRow,
  FacilityTypeInstanceRow,
  FacilityTypeRow,
  MapFilterGroupRow,
  MapFilterPlaceEntryRow,
  MerchantFilterRow,
  PlaceKindRow,
} from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import { FacilityGlyph, facilityIconKeyLabel } from "../../lib/facilityIcons";
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
  errorMessage,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// 分类管理：前台地图上那排筛选按钮，以及按钮背后的两类东西。
//
// 这个页面此前有三层：标签 → 成员 → 类型。但库里 19 个标签对应 19 个成员，一个标签
// 从来没有装过两样东西——「容器」这一层在真实数据里一次都没用上，屏幕上却要求维护者
// 先理解它、先挑一个，才能建一个类型。
//
// 现在只有两份清单：
//
//   1. 地点类型 —— 整座楼、整片区域这种「地方」（建筑、图书馆、宿舍…）
//   2. 设施类型 —— 挂在地方里的具体品类（打印机、饮水点、电梯…）
//
// 每个类型自带一个筛选按钮，按钮的名称 / 排序 / 是否显示作为类型自己的属性，在同一
// 张卡片里改。新建时后台自动建按钮，不再要求先选容器。
//
// 底层表结构没动（一个按钮仍可挂多个成员），发布产物形状也没变，所以前台与已发布的
// 版本都不受影响。真出现一个按钮挂了多个成员的历史数据，页面底部会如实列出来。
// ---------------------------------------------------------------------------

const ERROR_TEXT: Record<string, string> = {
  code_taken: "这个英文编码已经被别的设施类型占用了，换一个再试。",
  invalid_code: "英文编码只能用小写字母、数字和下划线，并以字母开头。",
  code_immutable: "已有设施类型的英文编码不能修改。要换编码请新建一个，再把旧的停用。",
  unsupported_icon_key: "选择的图标不在支持范围内，请重新选择。",
  facility_type_in_use: "这个设施类型仍被点位或采集记录引用，不能删除。可以先停用它。",
  duplicate_place_kind: "这个地点类型 ID 已经存在了，换一个再试。",
  place_kind_in_use: "这个地点类型下还有地点，不能删除。",
  place_kind_unmapped: "这个地点类型还没有自己的筛选按钮，无法修改按钮属性。",
  map_filter_shared: "这个筛选按钮还挂着别的类型，不能在这里单独改。请到页面底部的「需要处理的按钮」里处理。",
  map_filter_in_use: "这个按钮下还有在用的内容，不能从筛选栏隐藏。",
  inactive_map_filter: "启用中的类型必须让它的筛选按钮也处于显示状态。",
  validation_error: "填写的内容不完整或不正确，请检查后重试。",
  forbidden: "当前账号没有维护分类的权限。",
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
    hint: "关掉时，只有搜到它或点了它的筛选按钮才会出现在地图上",
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
    hint: "关掉后点它的筛选按钮也不会把它筛出来",
  },
  {
    key: "showWhenUnavailable" as const,
    label: "不可用时仍显示",
    fallback: true,
    hint: "关掉后，实时状态为「不可用」的点位会从地图上隐去",
  },
];

function IconPreview({
  iconKey,
  size = 18,
  label,
}: {
  iconKey: string | null;
  size?: number;
  /** 自定义图标的中文名（内置图标从 FACILITY_ICON_KEY_LABELS 取，不用传）。 */
  label?: string;
}) {
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-container text-primary"
      title={label}
    >
      <FacilityGlyph iconKey={iconKey} size={size} />
    </span>
  );
}

/**
 * 图标选择：点一下就换，左边实时显示当前选中的样子。
 *
 * 两排格子：内置图标（硬编码 23 枚）+ 后台上传的自定义图标（0029）。分两排而不是
 * 混在一起，因为它们能做的事不同——自定义的可以删、可以停用，内置的不能。
 */
function IconChooser({
  value,
  iconKeys,
  customIcons,
  canEdit,
  onChange,
  onUploaded,
}: {
  value: string;
  iconKeys: string[];
  customIcons: CustomFacilityIconRow[];
  canEdit: boolean;
  onChange: (value: string) => void;
  /** 上传成功：把新图标并进本地列表并选中它（不重新拉数据，见 ADMIN_REFRESH_EXCLUSIONS）。 */
  onUploaded: (icon: CustomFacilityIconRow) => void;
}) {
  const [uploading, setUploading] = useState(false);
  // 停用的图标不作为可选项，但如果当前类型正用着它，仍要显示出来（否则界面上看不到自己选的是什么）。
  const selectable = customIcons.filter((icon) => icon.status === "active" || icon.iconKey === value);
  const currentCustom = customIcons.find((icon) => icon.iconKey === value) ?? null;
  const currentLabel = currentCustom ? currentCustom.label : facilityIconKeyLabel(value);

  function cell(key: string, label: string, active: boolean) {
    return (
      <button
        aria-label={label}
        aria-pressed={active}
        className={`grid h-8 w-8 place-items-center rounded-lg border transition-colors ${
          active ? "border-primary bg-primary-container text-primary" : "border-line text-sub hover:text-ink"
        }`}
        key={key}
        onClick={() => onChange(key)}
        title={label}
        type="button"
      >
        <FacilityGlyph iconKey={key} size={16} />
      </button>
    );
  }

  return (
    <div>
      <span className="mb-1.5 block text-label text-sub">图标</span>
      <div className="flex items-center gap-2.5">
        <IconPreview iconKey={value || null} label={currentCustom?.label} />
        <span className="text-aux text-sub">
          {currentLabel}
          {currentCustom ? <span className="ml-1.5 text-label text-primary">自定义</span> : null}
          {currentCustom && currentCustom.status !== "active"
            ? <span className="ml-1.5 text-label text-warning">已停用</span>
            : null}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {iconKeys.map((key) => cell(key, facilityIconKeyLabel(key), key === value))}
      </div>

      {selectable.length > 0 || canEdit ? (
        <div className="mt-3">
          <span className="mb-1.5 block text-label text-sub">
            自定义图标{selectable.length > 0 ? ` · ${selectable.length} 枚` : ""}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {selectable.map((icon) => cell(icon.iconKey, icon.label, icon.iconKey === value))}
            {canEdit ? (
              <button
                aria-label="上传新图标"
                className="grid h-8 w-8 place-items-center rounded-lg border border-dashed border-line text-sub transition-colors hover:border-primary hover:text-primary"
                onClick={() => setUploading((open) => !open)}
                title="上传新图标"
                type="button"
              >
                <Plus size={15} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {uploading ? (
        <IconUploader
          onClose={() => setUploading(false)}
          onUploaded={(icon) => {
            onUploaded(icon);
            onChange(icon.iconKey);
            setUploading(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 上传一枚自定义图标（0029）。
 *
 * 要求写在界面上而不只写在文档里：服务端对颜色和 viewBox 是拒收而非自动改写
 * （改写要穷举所有写法，漏一个就产出一枚颜色改不掉的图标），所以上传者必须在
 * 动手之前就知道该怎么导出。
 */
function IconUploader({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: (icon: CustomFacilityIconRow) => void;
}) {
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const iconKey = `custom-${slug.trim()}`;
  const slugOk = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim()) && iconKey.length <= 50;
  const ready = label.trim().length > 0 && slugOk && file !== null;

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const svg = await file.text();
      const result = await admin.uploadFacilityIcon(iconKey, svg, label.trim());
      onUploaded({ iconKey: result.iconKey, label: result.label, status: result.status });
    } catch (err) {
      setError(labelError(err, "上传失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-line bg-page p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-body font-semibold text-ink">上传自定义图标</span>
        <button
          aria-label="收起"
          className="grid h-7 w-7 place-items-center rounded-lg text-sub hover:text-ink"
          onClick={onClose}
          type="button"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Field label="图标名称" onChange={setLabel} placeholder="如 直饮水机" value={label} />
        <Field
          label="英文编码（自动加 custom- 前缀）"
          onChange={(value) => setSlug(value.toLowerCase())}
          placeholder="如 water-dispenser"
          value={slug}
        />
      </div>
      {slug.trim() && !slugOk ? (
        <p className="mt-2 text-aux text-warning">
          编码只能用小写字母、数字和连字符（不能以连字符开头或结尾），加上 custom- 前缀后不超过 50 个字符。
        </p>
      ) : slug.trim() ? (
        <p className="mt-2 text-label text-sub">将保存为 <code className="text-primary">{iconKey}</code></p>
      ) : null}

      <div className="mt-3">
        <span className="mb-1.5 block text-label text-sub">SVG 文件</span>
        <input
          accept=".svg,image/svg+xml"
          className="block w-full text-aux text-sub file:mr-3 file:rounded-lg file:border-0 file:bg-primary-container file:px-3 file:py-2 file:text-aux file:font-semibold file:text-primary"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          type="file"
        />
      </div>

      <div className="mt-3">
        <InfoNote>
          <span className="font-semibold">图标要求</span>（不满足会被拒收，并告诉你哪一条）：
          <br />· 单色描边、不填充，线宽 2，24×24 视图（与内置图标同一套 lucide 风格）
          <br />· 必须带 viewBox，建议 <code>0 0 24 24</code>
          <br />· 颜色只能写 <code>currentColor</code> 或 <code>none</code>：图钉有两态（未选中是白底蓝图标、
          选中是蓝底白图标），写死色值就没法上第二种色。也因此不能用渐变、图案或 <code>&lt;style&gt;</code> 样式块
          <br />· 不要放文字：地图上只画 22px，字读不出来
          <br />· 不含 <code>&lt;script&gt;</code>、on* 事件属性、外部引用
          <br />· 单文件不超过 64KB
        </InfoNote>
      </div>

      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      <div className="mt-3 flex gap-2">
        <PrimaryButton disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "上传中…" : "上传图标"}
        </PrimaryButton>
        <GhostButton disabled={busy} onClick={onClose}>取消</GhostButton>
      </div>
    </div>
  );
}

/**
 * 一个筛选按钮当前长什么样：名称 +（隐藏时）一个提示。
 *
 * 按钮名与类型名经常不同（`building`「建筑」的按钮叫「教学楼」），所以两个都要显示，
 * 否则维护者会以为改了类型名前台就跟着变。
 */
function FilterSummary({
  filterLabel,
  filterActive,
  filterSortOrder,
}: {
  filterLabel: string | null;
  filterActive: boolean | null;
  filterSortOrder: number | null;
}) {
  if (filterLabel === null) return <span className="text-warning">没有筛选按钮</span>;
  return (
    <>
      筛选按钮「{filterLabel}」
      {filterActive === false ? <span className="text-warning">（不显示）</span> : null}
      {filterSortOrder === null ? null : ` · 按钮排序 ${filterSortOrder}`}
    </>
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

/** 一个地点类型下挂着的地点清单，点进去到地点编辑页。 */
function PlaceEntryList({ entries, canEdit }: { entries: MapFilterPlaceEntryRow[]; canEdit: boolean }) {
  if (!entries.length) {
    return <div className="px-4 pb-4"><EmptyState label="这个地点类型下还没有地点" /></div>;
  }
  return (
    <div className="px-4 pb-4">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-label text-sub">
            <th className="px-3 pb-2 pt-1 font-medium">名称</th>
            <th className="px-3 pb-2 pt-1 font-medium">校区</th>
            <th className="px-3 pb-2 pt-1 font-medium">形态</th>
            <th className="px-3 pb-2 pt-1 font-medium">状态</th>
            <th className="px-3 pb-2 pt-1 text-right font-medium" />
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
    </div>
  );
}

/** 新建地点类型。ID 建立后不可改，所以只有新建时能填。 */
function PlaceKindForm({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("100");
  const [filterLabel, setFilterLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const idOk = /^[a-z][a-z0-9_]*$/.test(id.trim());
  const ready = idOk && name.trim().length > 0;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await admin.createPlaceKind({
        id: id.trim(),
        name: name.trim(),
        sortOrder: Number(sortOrder) || 100,
        isSearchable: true,
        // 留空就沿用类型名。服务端也是这个规则，这里显式传是为了少一次歧义。
        filterLabel: filterLabel.trim() || name.trim(),
        filterSortOrder: Number(sortOrder) || 100,
      });
      onSaved(`已新增地点类型「${name.trim()}」`);
      onClose();
    } catch (err) {
      setError(labelError(err, "新增失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="新增地点类型">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="名称" onChange={setName} placeholder="如 图书馆" value={name} />
        <Field label="ID（英文，建立后不可改）" onChange={(v) => setId(v.toLowerCase())} placeholder="如 library" value={id} />
        <Field
          label="筛选按钮名称（留空则同名称）"
          onChange={setFilterLabel}
          placeholder={name.trim() || "如 图书馆"}
          value={filterLabel}
        />
        <Field label="排序" onChange={setSortOrder} type="number" value={sortOrder} />
      </div>
      <p className="mt-3 text-label text-sub">
        新建后前台筛选栏会多出一个按钮。按钮名可以和类型名不同——「建筑」这一类的按钮就叫「教学楼」。
      </p>
      {id.trim() && !idOk ? (
        <p className="mt-2 text-aux text-warning">ID 只能用小写字母、数字和下划线，并以字母开头。</p>
      ) : null}
      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      <div className="mt-4 flex gap-2">
        <PrimaryButton disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "提交中…" : "创建地点类型"}
        </PrimaryButton>
        <GhostButton disabled={busy} onClick={onClose}>取消</GhostButton>
      </div>
    </Panel>
  );
}

/** 一个地点类型的卡片：类型属性 + 它那个筛选按钮 + 可展开的地点明细。 */
function PlaceKindCard({
  kind,
  canEdit,
  onChanged,
}: {
  kind: PlaceKindRow;
  canEdit: boolean;
  onChanged: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(kind.name);
  const [sortOrder, setSortOrder] = useState(String(kind.sortOrder));
  const [filterLabel, setFilterLabel] = useState(kind.filterLabel ?? "");
  const [filterSortOrder, setFilterSortOrder] = useState(String(kind.filterSortOrder ?? kind.sortOrder));

  // 按钮还挂着别的成员时（历史数据）就地改会牵连另一个类型，服务端会拒。
  const filterEditable = kind.categoryId !== null && kind.filterMemberCount <= 1;
  const removable = kind.placeCount === 0;

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

  function startEdit() {
    setName(kind.name);
    setSortOrder(String(kind.sortOrder));
    setFilterLabel(kind.filterLabel ?? "");
    setFilterSortOrder(String(kind.filterSortOrder ?? kind.sortOrder));
    setEditing(true);
  }

  async function save() {
    await run(
      () => admin.updatePlaceKind(kind.id, {
        name: name.trim(),
        sortOrder: Number(sortOrder) || 0,
        ...(filterEditable
          ? { filterLabel: filterLabel.trim() || name.trim(), filterSortOrder: Number(filterSortOrder) || 0 }
          : {}),
      }),
      `已保存地点类型「${name.trim()}」`,
      "保存失败",
    );
    setEditing(false);
  }

  return (
    <section className="rounded-xl bg-surface">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <button
          aria-expanded={open}
          aria-label={open ? `收起「${kind.name}」下的地点` : `展开「${kind.name}」下的地点`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sub hover:bg-page hover:text-ink"
          onClick={() => setOpen((value) => !value)}
          title={open ? "收起地点" : "展开地点"}
          type="button"
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-body font-medium text-ink">
            {kind.name}
            {kind.filterActive === false ? <Pill tone="neutral">按钮已隐藏</Pill> : null}
          </p>
          <p className="mt-0.5 text-label text-sub">
            <code>{kind.id}</code> ·{" "}
            <FilterSummary
              filterActive={kind.filterActive}
              filterLabel={kind.filterLabel}
              filterSortOrder={kind.filterSortOrder}
            />
            {` · 排序 ${kind.sortOrder}`}
          </p>
        </div>
        <button
          className="shrink-0 rounded-lg px-2.5 py-1 text-aux text-sub hover:bg-page hover:text-ink"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {kind.placeCount} 个地点
        </button>
        {canEdit ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <GhostButton disabled={busy} onClick={startEdit}><Pencil size={13} />编辑</GhostButton>
            {filterEditable ? (
              <GhostButton
                danger={kind.filterActive === true}
                disabled={busy}
                onClick={() => void run(
                  () => admin.updatePlaceKind(kind.id, { filterActive: kind.filterActive !== true }),
                  kind.filterActive === true
                    ? `已把「${kind.filterLabel ?? kind.name}」从前台筛选栏隐藏`
                    : `已把「${kind.filterLabel ?? kind.name}」显示在前台筛选栏`,
                  "操作失败",
                )}
                title="控制前台筛选栏里要不要出现这个按钮"
              >
                {kind.filterActive === true ? <EyeOff size={13} /> : <Eye size={13} />}
                {kind.filterActive === true ? "隐藏按钮" : "显示按钮"}
              </GhostButton>
            ) : null}
            <GhostButton danger disabled={busy || !removable} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} />删除
            </GhostButton>
          </div>
        ) : null}
      </div>

      {error ? <div className="px-4 pb-3"><ErrorBanner message={error} /></div> : null}

      {!filterEditable && kind.categoryId !== null ? (
        <div className="px-4 pb-3">
          <InfoNote tone="warning">
            这个类型的筛选按钮还挂着别的类型，按钮名称与排序不能在这里单独改。见页面底部「需要处理的按钮」。
          </InfoNote>
        </div>
      ) : null}

      {editing ? (
        <div className="mx-4 mb-3.5 rounded-xl bg-page p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="名称" onChange={setName} value={name} />
            <Field label="排序" onChange={setSortOrder} type="number" value={sortOrder} />
            {filterEditable ? (
              <>
                <Field label="筛选按钮名称" onChange={setFilterLabel} placeholder={name} value={filterLabel} />
                <Field label="按钮排序" onChange={setFilterSortOrder} type="number" value={filterSortOrder} />
              </>
            ) : null}
          </div>
          <div className="mt-3.5 flex gap-2">
            <PrimaryButton disabled={busy || !name.trim()} onClick={() => void save()}>
              {busy ? "保存中…" : "保存修改"}
            </PrimaryButton>
            <GhostButton disabled={busy} onClick={() => setEditing(false)}><X size={14} />取消</GhostButton>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="mx-4 mb-3 rounded-lg bg-error-bg px-4 py-3">
          <p className="text-body font-medium text-error">
            确认删除「{kind.name}」？它的筛选按钮会一起删掉，删除后不可恢复。
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
              disabled={busy}
              onClick={() => void run(() => admin.deletePlaceKind(kind.id), `已删除地点类型「${kind.name}」`, "删除失败")}
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

      {open ? <PlaceEntryList canEdit={canEdit} entries={kind.entries} /> : null}
    </section>
  );
}

/** 新建 / 编辑设施类型。editing 为空即新建。 */
function FacilityTypeForm({
  editing,
  iconKeys,
  customIcons,
  canEdit,
  onClose,
  onSaved,
  onIconUploaded,
}: {
  editing: FacilityTypeRow | null;
  iconKeys: string[];
  customIcons: CustomFacilityIconRow[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  /** 上传成功后把新图标并进页面级列表（本表单不重新拉数据，见 ADMIN_REFRESH_EXCLUSIONS）。 */
  onIconUploaded: (icon: CustomFacilityIconRow) => void;
}) {
  const [code, setCode] = useState(editing?.code ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [iconKey, setIconKey] = useState(editing?.iconKey ?? "generic");
  const [interval, setInterval] = useState(
    editing?.verificationIntervalDays == null ? "" : String(editing.verificationIntervalDays),
  );
  const [filterLabel, setFilterLabel] = useState(editing?.filterLabel ?? "");
  const [filterSortOrder, setFilterSortOrder] = useState(
    editing?.filterSortOrder == null ? "100" : String(editing.filterSortOrder),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filterEditable = editing === null || editing.filterMemberCount <= 1;
  const codeOk = /^[a-z][a-z0-9_]*$/.test(code.trim().toLowerCase());
  const intervalOk = interval.trim() === "" || /^\d{1,4}$/.test(interval.trim());
  const ready = name.trim().length > 0 && (editing !== null || codeOk) && intervalOk;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const days = interval.trim() === "" ? null : Number(interval.trim());
      const filterFields = filterEditable
        ? { filterLabel: filterLabel.trim() || name.trim(), filterSortOrder: Number(filterSortOrder) || 100 }
        : {};
      if (editing) {
        await admin.updateFacilityType(editing.id, {
          name: name.trim(),
          iconKey: iconKey || null,
          verificationIntervalDays: days,
          ...filterFields,
        });
        onSaved(`已保存设施类型「${name.trim()}」`);
      } else {
        await admin.createFacilityType({
          code: code.trim().toLowerCase(),
          name: name.trim(),
          iconKey: iconKey || null,
          verificationIntervalDays: days,
          ...filterFields,
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
          label="英文编码（建立后不可改）"
          onChange={(value) => setCode(value.toLowerCase())}
          placeholder="如 charging_station"
          value={code}
        />
        {filterEditable ? (
          <>
            <Field
              label="筛选按钮名称（留空则同名称）"
              onChange={setFilterLabel}
              placeholder={name.trim() || "如 充电桩"}
              value={filterLabel}
            />
            <Field label="按钮排序" onChange={setFilterSortOrder} type="number" value={filterSortOrder} />
          </>
        ) : (
          <div className="md:col-span-2">
            <InfoNote tone="warning">
              这个类型的筛选按钮还挂着别的类型，按钮名称与排序不能在这里改。见页面底部「需要处理的按钮」。
            </InfoNote>
          </div>
        )}
        <Field label="建议复核间隔（天，可留空）" onChange={setInterval} placeholder="如 90" value={interval} />
      </div>
      <div className="mt-4 max-w-lg">
        <IconChooser
          canEdit={canEdit}
          customIcons={customIcons}
          iconKeys={iconKeys}
          onChange={setIconKey}
          onUploaded={onIconUploaded}
          value={iconKey}
        />
      </div>
      <p className="mt-3 text-label text-sub">
        {editing
          ? "英文编码是既有点位和已发布数据共用的稳定标识，建立后不再改动。需要换编码时请新增一个类型，再把这个停用。"
          : "名称给所有人看，英文编码用于系统内部关联，只能用小写字母、数字和下划线，建立后不可修改。新建后前台筛选栏会多出一个按钮。"}
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

/** 一个设施类型的卡片：类型属性 + 它那个筛选按钮 + 显示开关 + 可展开的点位。 */
function FacilityTypeCard({
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
            <code>{type.code}</code> ·{" "}
            <FilterSummary
              filterActive={type.filterActive}
              filterLabel={type.filterLabel}
              filterSortOrder={type.filterSortOrder}
            />
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
            <GhostButton danger disabled={busy || !removable} onClick={() => setConfirmDelete(true)}>
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
          <p className="text-body font-medium text-error">
            确认删除「{type.name}」？它的筛选按钮会一起删掉，删除后不可恢复。
          </p>
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

/**
 * 商户那一个筛选按钮。
 *
 * 商户是整类纳入的：没有「商户类型」这张表，所有门店共用一个按钮，所以这里只能改
 * 按钮本身的名称和排序，不像上面两类还有类型属性可改。
 */
function MerchantFilterCard({
  merchants,
  canEdit,
  onChanged,
}: {
  merchants: MerchantFilterRow;
  canEdit: boolean;
  onChanged: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [label, setLabel] = useState(merchants.filterLabel);
  const [sortOrder, setSortOrder] = useState(String(merchants.filterSortOrder));
  const editable = merchants.filterMemberCount <= 1;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await admin.updateMapFilter(merchants.categoryId, {
        label: label.trim(),
        sortOrder: Number(sortOrder) || 0,
      });
      onChanged(`已保存筛选按钮「${label.trim()}」`);
      setEditing(false);
    } catch (err) {
      setError(labelError(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="商户">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-container text-primary">
          <Store size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-ink">全部门店</p>
          <p className="mt-0.5 text-label text-sub">
            <FilterSummary
              filterActive={merchants.filterActive}
              filterLabel={merchants.filterLabel}
              filterSortOrder={merchants.filterSortOrder}
            />
            {` · ${merchants.outletCount} 个门店`}
          </p>
        </div>
        {canEdit && editable && !editing ? (
          <GhostButton onClick={() => { setLabel(merchants.filterLabel); setSortOrder(String(merchants.filterSortOrder)); setEditing(true); }}>
            <Pencil size={13} />编辑按钮
          </GhostButton>
        ) : null}
      </div>
      <p className="mt-3 text-aux leading-relaxed text-sub">
        商户没有「类型」这一层：所有门店共用这一个筛选按钮，所以这里只有按钮的名称和排序可改。
        具体门店在<Link className="font-medium text-primary hover:underline" to="/admin/content/merchants">商户管理</Link>里维护。
      </p>
      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      {editing ? (
        <div className="mt-3.5 rounded-xl bg-page p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="筛选按钮名称" onChange={setLabel} value={label} />
            <Field label="按钮排序" onChange={setSortOrder} type="number" value={sortOrder} />
          </div>
          <div className="mt-3.5 flex gap-2">
            <PrimaryButton disabled={busy || !label.trim()} onClick={() => void save()}>
              {busy ? "保存中…" : "保存修改"}
            </PrimaryButton>
            <GhostButton disabled={busy} onClick={() => setEditing(false)}><X size={14} />取消</GhostButton>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * 一个按钮挂了多个（或零个）成员的历史数据。
 *
 * 正常库里这一段不出现。真出现了必须如实列出来：这种按钮改名会同时影响多个类型，
 * 而空按钮会被发版校验直接拒绝，光看上面两份清单看不出问题在哪。
 */
function FilterGroupsPanel({
  groups,
  canEdit,
  onChanged,
}: {
  groups: MapFilterGroupRow[];
  canEdit: boolean;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function removeEmpty(group: MapFilterGroupRow) {
    setBusy(group.id);
    setError("");
    try {
      await admin.deleteMapFilter(group.id);
      onChanged(`已删除空按钮「${group.label}」`);
    } catch (err) {
      setError(labelError(err, "删除失败"));
    } finally {
      setBusy("");
    }
  }

  return (
    <Panel title="需要处理的按钮">
      <p className="text-aux leading-relaxed text-sub">
        正常情况下每个筛选按钮恰好对应一个类型。下面这些按钮不是——挂了多个类型的按钮改名会同时影响
        它们全部，一个类型都没挂的按钮会被发版校验拒绝。
      </p>
      {error ? <div className="mt-3"><ErrorBanner message={error} /></div> : null}
      <div className="mt-3 divide-y divide-line">
        {groups.map((group) => (
          <div className="flex flex-wrap items-center gap-3 py-3" key={group.id}>
            <span className="font-medium text-ink">{group.label}</span>
            <code className="text-aux text-sub">{group.key}</code>
            <Pill tone={group.memberCount === 0 ? "warning" : "neutral"}>
              {group.memberCount === 0 ? "没有成员" : `${group.memberCount} 个成员`}
            </Pill>
            <span className="flex-1 text-aux text-sub">{group.memberLabels || "—"}</span>
            <Pill tone={group.active ? "ok" : "neutral"}>{group.active ? "显示中" : "已隐藏"}</Pill>
            {/* 空按钮是唯一能在这里直接收拾干净的：它没挂任何类型，删掉不影响别的东西，
                而留着它会让发版校验一直失败。挂了多个类型的按钮不给一键操作 —— 那要先决定
                每个类型各自归到哪个新按钮下，不是一次点击能表达的。 */}
            {canEdit && group.memberCount === 0 ? (
              <GhostButton danger disabled={busy === group.id} onClick={() => void removeEmpty(group)}>
                <Trash2 size={13} />删除空按钮
              </GhostButton>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function TaxonomyPage() {
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

  const [notice, setNotice] = useState("");
  const [addingKind, setAddingKind] = useState(false);
  const [creatingType, setCreatingType] = useState(false);
  const [editingType, setEditingType] = useState<FacilityTypeRow | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  /*
   * 刚上传、但接口数据还没重新拉过的图标。
   *
   * 上传走的是被 ADMIN_REFRESH_EXCLUSIONS 排除的路径（否则广播会把正在填的表单
   * 清空），所以列表不会自动更新 —— 新图标由这里兜住，让它立刻能在选择器里选中。
   * 按 key 去重合并，下次 reload 拿到正式数据后不会出现两份。
   */
  const [uploadedIcons, setUploadedIcons] = useState<CustomFacilityIconRow[]>([]);

  if (state.status === "loading") return <LoadingState label="加载分类…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const { filters, facilityTypes } = state.data!;

  function afterChange(message: string) {
    setNotice(message);
    reload();
  }

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
  const unmappedKinds = filters.placeKinds.filter((kind) => kind.categoryId === null);
  // 接口数据优先：reload 之后同一个键以服务端那份为准，刚上传的那份自动让位。
  const customIcons = [
    ...facilityTypes.customIcons,
    ...uploadedIcons.filter(
      (icon) => !facilityTypes.customIcons.some((row) => row.iconKey === icon.iconKey),
    ),
  ];

  return (
    <div className="space-y-4">
      {notice ? <p className="rounded-lg bg-success-bg px-4 py-3 text-body font-medium text-success">{notice}</p> : null}

      <Panel title={<span className="inline-flex items-center gap-2"><Tags className="text-sub" size={16} />这个页面管什么</span>}>
        <p className="text-aux leading-relaxed text-sub">
          前台地图上那排可以点的筛选按钮，就是这里维护的。按钮背后只有两类东西：
          <span className="text-ink">地点类型</span>是「地方」（建筑、图书馆、宿舍），
          <span className="text-ink">设施类型</span>是挂在地方里的品类（打印机、饮水点、电梯）。
          <br />
          每个类型自带一个筛选按钮，按钮的名称和排序就在类型自己的卡片里改——按钮名可以和类型名不同，
          比如「建筑」这一类的按钮叫「教学楼」。新建类型时按钮自动建好，不需要另外操作。
        </p>
      </Panel>

      {/* 地点类型 */}
      <Panel
        action={canEdit && !addingKind ? (
          <GhostButton onClick={() => setAddingKind(true)}><Plus size={14} />新增地点类型</GhostButton>
        ) : undefined}
        title="地点类型"
      >
        <p className="text-aux leading-relaxed text-sub">
          一个地点属于哪个地点类型，决定它在前台归到哪个筛选按钮下，也决定它在搜索结果里怎么显示。
          展开卡片能看到这个类型下具体有哪些地点。
        </p>
      </Panel>

      {addingKind ? (
        <PlaceKindForm onClose={() => setAddingKind(false)} onSaved={afterChange} />
      ) : null}

      {unmappedKinds.length > 0 ? (
        <InfoNote tone="warning">
          有 {unmappedKinds.length} 个地点类型没有筛选按钮（{unmappedKinds.map((kind) => kind.name).join("、")}）。
          这类地点无法新建，服务端会直接拒绝。
        </InfoNote>
      ) : null}

      <div className="space-y-2.5">
        {filters.placeKinds.map((kind) => (
          <PlaceKindCard canEdit={canEdit} key={kind.id} kind={kind} onChanged={afterChange} />
        ))}
      </div>

      {/* 设施类型 */}
      {creatingType || editingType ? (
        <FacilityTypeForm
          canEdit={canEdit}
          customIcons={customIcons}
          editing={editingType}
          iconKeys={facilityTypes.iconKeys}
          onClose={() => { setCreatingType(false); setEditingType(null); }}
          onIconUploaded={(icon) => setUploadedIcons((list) => [...list.filter((row) => row.iconKey !== icon.iconKey), icon])}
          onSaved={afterChange}
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
          设施类型是挂在地方里的具体品类：打印机、饮水点、电梯。停用一个类型后，它不再出现在新建设施和
          志愿者采集的可选项里，但已经录入的点位照常展示。只有一个点位都没挂、也没被采集记录引用的类型才能彻底删除。
        </p>
      </Panel>

      {visibleTypes.length === 0 ? (
        <EmptyState label="没有符合条件的设施类型" />
      ) : (
        <div className="space-y-2.5">
          {visibleTypes.map((type) => (
            <FacilityTypeCard
              canEdit={canEdit}
              key={type.id}
              onChanged={afterChange}
              onEdit={() => { setCreatingType(false); setNotice(""); setEditingType(type); }}
              type={type}
            />
          ))}
        </div>
      )}

      {/* 商户 */}
      {filters.merchants === null ? (
        <InfoNote tone="warning">
          商户还没有筛选按钮，门店无法新建。需要先建立一个纳入商户的筛选按钮。
        </InfoNote>
      ) : (
        <MerchantFilterCard canEdit={canEdit} merchants={filters.merchants} onChanged={afterChange} />
      )}

      {filters.groups.length > 0 ? (
        <FilterGroupsPanel canEdit={canEdit} groups={filters.groups} onChanged={afterChange} />
      ) : null}
    </div>
  );
}
