import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type {
  FacilityDetailResponse,
  MerchantDetailResponse,
  OperationalEventRow,
  PlaceDetailResponse,
  ReferenceDataResponse,
} from "../adminTypes";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  GhostButton,
  SEVERITY_LABELS,
  TextArea,
  errorMessage,
  fmtDateTime,
  fmtRelative,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A3 审核中心（左队列 + 右结构化对比 / 审核操作）
//
// 右侧把待审修订和上一版已发布内容按「基本信息 / 详细信息 / 图片 / 楼层采集」
// 四个分区并排对照。采集提交生成的修订，主体内容都在楼层采集里，所以正文字段
// 之外的内容也必须完整呈现，审核员才知道自己批的是什么。
// ---------------------------------------------------------------------------

type RevisionKind = "place" | "facility" | "merchant";

type QueueItem =
  | { kind: RevisionKind; id: string; revisionId: string | null; title: string; at: string }
  | { kind: "operation"; id: string; title: string; at: string; severity: string }
  | { kind: "submission"; id: string; title: string; at: string };

const KIND_META: Record<QueueItem["kind"], { label: string; filter: string }> = {
  place: { label: "地点", filter: "地点" },
  facility: { label: "设施", filter: "设施" },
  merchant: { label: "商户", filter: "商户" },
  operation: { label: "运营", filter: "运营事件" },
  submission: { label: "提交", filter: "用户提交" },
};

const EMPTY_TEXT = "未填写";

/** 用户提交的目标类型 → 中文，避免队列里出现原始编码。 */
const TARGET_TYPE_LABELS: Record<string, string> = {
  place: "地点",
  new_place: "新地点",
  facility: "设施",
  merchant_outlet: "商户",
  transit_stop: "校车站点",
};

// ---------------------------------------------------------------------------
// 修订内容解析（content_json 及各 *_json 列都是文本，需先解析）
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function isObject(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function parseObject(raw: unknown): Row {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nestedText(raw: unknown, key: string): string {
  return text(parseObject(raw)[key]);
}

interface DiffRow {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

interface MediaItem {
  url: string;
  state: "added" | "removed" | "kept";
}

interface FloorFacilityView {
  name: string;
  typeLabel: string;
  locationText: string;
}

interface FloorView {
  /** 采集时填的楼层编号，仅用于两侧配对，不直接显示。 */
  levelCode: string;
  /** 给人看的楼层名，与通过审核后写入的显示名保持一致。 */
  levelLabel: string;
  note: string;
  facilities: FloorFacilityView[];
  photoCount: number;
}

interface FloorRow {
  floor: FloorView;
  state: "added" | "removed" | "changed" | "kept";
}

interface DiffModel {
  meta: string;
  basic: DiffRow[];
  facts: DiffRow[];
  media: MediaItem[];
  floors: FloorRow[];
  otherCount: number;
}

/** detail.facts 缺失时的兜底键，与客户端详情页的取值口径一致。 */
const FACT_FALLBACK: Array<[string, string]> = [
  ["所属单位", "organization"],
  ["进入方式", "accessMethod"],
  ["开放时间", "openHours"],
  ["联系电话", "phone"],
];

const PLACE_CONTENT_KEYS = new Set([
  "detail",
  "collectionFloors",
  "collectionSubmissionId",
  "floorNotes",
  "address",
  "media",
  "coverImageUrl",
  "legacySvgElementId",
  "legacyCategory",
]);

const PLACE_DETAIL_KEYS = new Set([
  "facts",
  "media",
  "coverImageUrl",
  "galleryImageUrl",
  "organization",
  "accessMethod",
  "openHours",
  "phone",
  "summary",
  "description",
]);

// 标签与编辑器里的字段名保持一致，审核员和编辑看到的是同一套说法。
const FACILITY_CONTENT_FIELDS: Array<[string, string]> = [
  ["位置描述", "locationDescription"],
  ["收费标准", "fee"],
  ["备注", "note"],
];

const MERCHANT_CONTENT_FIELDS: Array<[string, string]> = [
  ["人均", "avgPrice"],
  ["档口号", "stallCode"],
  ["简介", "summary"],
];

/** 详细信息：label → value。地点侧同时兼容 facts 数组与散字段两种写法。 */
function placeFacts(content: Row): Map<string, string> {
  const facts = new Map<string, string>();
  const detail = isObject(content.detail) ? content.detail : {};
  if (Array.isArray(detail.facts)) {
    for (const raw of detail.facts) {
      if (!isObject(raw)) continue;
      const label = text(raw.label);
      if (label) facts.set(label, text(raw.value));
    }
  }
  for (const [label, key] of FACT_FALLBACK) {
    if (facts.has(label)) continue;
    const value = text(detail[key]);
    if (value) facts.set(label, value);
  }
  const address = text(content.address);
  if (address) facts.set("地址", address);
  const floorNotes = text(content.floorNotes);
  if (floorNotes) facts.set("楼层备注", floorNotes);
  return facts;
}

function fieldFacts(content: Row, fields: Array<[string, string]>): Map<string, string> {
  const facts = new Map<string, string>();
  for (const [label, key] of fields) {
    const value = text(content[key]);
    if (value) facts.set(label, value);
  }
  return facts;
}

function menuText(content: Row): string {
  if (!Array.isArray(content.menu)) return "";
  return content.menu
    .map((item) => (isObject(item) ? text(item.name) : text(item)))
    .filter(Boolean)
    .join("、");
}

/** 图片地址：detail.media / content.media（字符串或 {url}）+ 单图字段。 */
function mediaUrls(content: Row): string[] {
  const detail = isObject(content.detail) ? content.detail : {};
  const urls: string[] = [];
  const push = (value: string) => {
    if (value && !urls.includes(value)) urls.push(value);
  };
  for (const source of [detail.media, content.media]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      push(isObject(item) ? text(item.url) : text(item));
    }
  }
  push(text(detail.coverImageUrl));
  push(text(detail.galleryImageUrl));
  push(text(content.coverImageUrl));
  return urls;
}

/**
 * 楼层编号（"3" / "F3" / "B1"）→ 给人看的楼层名。
 * 与修订通过后写入楼层表的显示名同一口径，审核时看到的就是发布后的样子。
 */
function floorLabel(levelCode: string): string {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^F?(\d{1,3})$/);
  if (above) return `${Number(above[1])} 层`;
  const below = code.match(/^B(\d{1,2})$/);
  if (below) return `地下 ${Number(below[1])} 层`;
  return levelCode.trim();
}

function collectionFloors(content: Row, typeNames: Map<string, string>): FloorView[] {
  if (!Array.isArray(content.collectionFloors)) return [];
  const floors: FloorView[] = [];
  for (const raw of content.collectionFloors) {
    if (!isObject(raw)) continue;
    const levelCode = text(raw.levelCode);
    if (!levelCode) continue;
    const facilities: FloorFacilityView[] = [];
    if (Array.isArray(raw.facilities)) {
      for (const item of raw.facilities) {
        if (!isObject(item)) continue;
        const typeLabel = typeNames.get(text(item.typeCode)) ?? "";
        const name = text(item.name);
        if (!name && !typeLabel) continue;
        facilities.push({ name: name || typeLabel, typeLabel, locationText: text(item.locationText) });
      }
    }
    floors.push({
      levelCode,
      levelLabel: floorLabel(levelCode),
      note: text(raw.note),
      facilities,
      photoCount: Array.isArray(raw.photoMediaIds) ? raw.photoMediaIds.length : 0,
    });
  }
  return floors;
}

function diffRows(before: Map<string, string>, after: Map<string, string>): DiffRow[] {
  const labels = [...after.keys(), ...[...before.keys()].filter((label) => !after.has(label))];
  return labels.map((label) => {
    const beforeValue = before.get(label) ?? "";
    const afterValue = after.get(label) ?? "";
    return { label, before: beforeValue, after: afterValue, changed: beforeValue !== afterValue };
  });
}

function mediaDiff(before: string[], after: string[]): MediaItem[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after.map((url): MediaItem => ({ url, state: beforeSet.has(url) ? "kept" : "added" })),
    ...before.filter((url) => !afterSet.has(url)).map((url): MediaItem => ({ url, state: "removed" })),
  ];
}

function floorSignature(floor: FloorView): string {
  return JSON.stringify([floor.note, floor.photoCount, floor.facilities]);
}

function floorDiff(before: FloorView[], after: FloorView[]): FloorRow[] {
  const beforeMap = new Map(before.map((floor) => [floor.levelCode, floor]));
  const afterMap = new Map(after.map((floor) => [floor.levelCode, floor]));
  const rows: FloorRow[] = after.map((floor) => {
    const previous = beforeMap.get(floor.levelCode);
    if (!previous) return { floor, state: "added" };
    return { floor, state: floorSignature(previous) === floorSignature(floor) ? "kept" : "changed" };
  });
  for (const floor of before) {
    if (!afterMap.has(floor.levelCode)) rows.push({ floor, state: "removed" });
  }
  return rows;
}

/** 已识别之外的键：只报变化数量，不把原始结构倾倒到界面上。 */
function countOtherChanges(before: Row, after: Row, known: Set<string>, detailKnown?: Set<string>): number {
  let count = 0;
  const compare = (left: Row, right: Row, skip: Set<string>) => {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (skip.has(key)) continue;
      if (JSON.stringify(left[key] ?? null) !== JSON.stringify(right[key] ?? null)) count += 1;
    }
  };
  compare(before, after, known);
  if (detailKnown) {
    compare(
      isObject(before.detail) ? before.detail : {},
      isObject(after.detail) ? after.detail : {},
      detailKnown,
    );
  }
  return count;
}

export function buildDiff(
  kind: RevisionKind,
  current: Row,
  baseline: Row | undefined,
  typeNames: Map<string, string>,
): DiffModel {
  const afterContent = parseObject(current.content_json);
  const beforeContent = parseObject(baseline?.content_json);
  const basic: DiffRow[] = [];
  const pushBasic = (label: string, before: string, after: string) => {
    basic.push({ label, before, after, changed: before !== after });
  };
  pushBasic("名称", text(baseline?.display_name), text(current.display_name));

  let beforeFacts = new Map<string, string>();
  let afterFacts = new Map<string, string>();
  let otherCount = 0;

  if (kind === "place") {
    pushBasic("简介", text(baseline?.summary), text(current.summary));
    pushBasic("详细描述", text(baseline?.description), text(current.description));
    beforeFacts = placeFacts(beforeContent);
    afterFacts = placeFacts(afterContent);
    otherCount = countOtherChanges(beforeContent, afterContent, PLACE_CONTENT_KEYS, PLACE_DETAIL_KEYS);
  } else if (kind === "facility") {
    pushBasic("服务时间", nestedText(baseline?.service_hours_json, "text"), nestedText(current.service_hours_json, "text"));
    beforeFacts = fieldFacts(beforeContent, FACILITY_CONTENT_FIELDS);
    afterFacts = fieldFacts(afterContent, FACILITY_CONTENT_FIELDS);
    otherCount = countOtherChanges(
      beforeContent,
      afterContent,
      new Set([...FACILITY_CONTENT_FIELDS.map(([, key]) => key), "detail", "media"]),
    );
  } else {
    pushBasic("分类", text(baseline?.business_type), text(current.business_type));
    pushBasic("营业时间", nestedText(baseline?.opening_hours_json, "text"), nestedText(current.opening_hours_json, "text"));
    pushBasic("联系电话", nestedText(baseline?.contact_json, "phone"), nestedText(current.contact_json, "phone"));
    beforeFacts = fieldFacts(beforeContent, MERCHANT_CONTENT_FIELDS);
    afterFacts = fieldFacts(afterContent, MERCHANT_CONTENT_FIELDS);
    const beforeMenu = menuText(beforeContent);
    const afterMenu = menuText(afterContent);
    if (beforeMenu) beforeFacts.set("菜单", beforeMenu);
    if (afterMenu) afterFacts.set("菜单", afterMenu);
    otherCount = countOtherChanges(
      beforeContent,
      afterContent,
      new Set([...MERCHANT_CONTENT_FIELDS.map(([, key]) => key), "menu", "detail", "media"]),
    );
  }

  const revisionNo = text(current.revision_no);
  const submittedAt = text(current.submitted_at) || text(current.created_at);
  const meta = [
    revisionNo ? `修订 #${revisionNo}` : "",
    submittedAt ? `提交于 ${fmtDateTime(submittedAt)}` : "",
    baseline ? "" : "首次提交，暂无历史版本可对照",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    meta,
    basic,
    facts: diffRows(beforeFacts, afterFacts),
    media: mediaDiff(mediaUrls(beforeContent), mediaUrls(afterContent)),
    floors: kind === "place"
      ? floorDiff(collectionFloors(beforeContent, typeNames), collectionFloors(afterContent, typeNames))
      : [],
    otherCount,
  };
}

// ---------------------------------------------------------------------------
// 分区渲染
// ---------------------------------------------------------------------------

function DiffSection({
  title,
  changedCount,
  children,
}: {
  title: string;
  changedCount: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(changedCount > 0);
  return (
    <section className="overflow-hidden rounded-lg bg-page">
      <button
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="flex items-center gap-2.5">
          <span className="text-emphasis">{title}</span>
          {changedCount > 0 ? <Pill tone="warning">{changedCount} 处变化</Pill> : <Pill>无变化</Pill>}
        </span>
        <span className="text-label text-sub">{open ? "收起" : "展开"}</span>
      </button>
      {open ? <div className="border-t border-line px-4 py-3">{children}</div> : null}
    </section>
  );
}

function DiffRowList({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[104px_1fr_20px_1fr] gap-2 px-2 text-label text-sub">
        <span>字段</span>
        <span>原内容</span>
        <span />
        <span>本次提交</span>
      </div>
      {rows.map((row) => (
        <div
          className={`grid grid-cols-[104px_1fr_20px_1fr] items-start gap-2 rounded-md px-2 py-1.5 text-body ${row.changed ? "bg-warning-bg" : ""}`}
          key={row.label}
        >
          <span className="text-sub">{row.label}</span>
          <span className="whitespace-pre-wrap break-words text-sub">{row.before || EMPTY_TEXT}</span>
          <span className="text-center text-sub">→</span>
          <span className={`whitespace-pre-wrap break-words text-ink ${row.changed ? "font-medium" : ""}`}>
            {row.after || EMPTY_TEXT}
          </span>
        </div>
      ))}
    </div>
  );
}

const MEDIA_STATE_META: Record<MediaItem["state"], { label: string; border: string; text: string }> = {
  added: { label: "新增", border: "border-success", text: "text-success" },
  removed: { label: "已移除", border: "border-error", text: "text-error" },
  kept: { label: "保留", border: "border-line", text: "text-sub" },
};

function MediaThumb({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  const meta = MEDIA_STATE_META[item.state];
  return (
    <figure className="w-24">
      <div className={`grid h-24 w-24 place-items-center overflow-hidden rounded-lg border-2 bg-surface ${meta.border}`}>
        {failed ? (
          <span className="px-1.5 text-center text-label text-sub">图片无法显示</span>
        ) : (
          <img
            alt={`${meta.label}的照片`}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
            src={item.url}
          />
        )}
      </div>
      <figcaption className={`mt-1 text-center text-label ${meta.text}`}>{meta.label}</figcaption>
    </figure>
  );
}

const FLOOR_STATE_META: Record<FloorRow["state"], { label: string; tone: "ok" | "error" | "warning" | "neutral" }> = {
  added: { label: "新增楼层", tone: "ok" },
  removed: { label: "已删除楼层", tone: "error" },
  changed: { label: "有修改", tone: "warning" },
  kept: { label: "无变化", tone: "neutral" },
};

function FloorCard({ row }: { row: FloorRow }) {
  const meta = FLOOR_STATE_META[row.state];
  const { floor } = row;
  return (
    <div className="rounded-lg bg-surface px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className="text-emphasis">{floor.levelLabel}</span>
        <Pill tone={meta.tone}>{meta.label}</Pill>
        <span className="text-label text-sub">
          {floor.facilities.length} 项设施
          {floor.photoCount > 0 ? ` · ${floor.photoCount} 张平面图照片` : ""}
        </span>
      </div>
      <p className="mt-1.5 text-aux text-sub">备注：{floor.note || EMPTY_TEXT}</p>
      {floor.facilities.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {floor.facilities.map((facility, index) => (
            <li className="text-body text-ink" key={`${facility.name}:${index}`}>
              {facility.name}
              {facility.typeLabel && facility.typeLabel !== facility.name ? (
                <span className="text-sub">（{facility.typeLabel}）</span>
              ) : null}
              {facility.locationText ? <span className="text-sub"> · {facility.locationText}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-body text-sub">本层未记录设施</p>
      )}
    </div>
  );
}

export function RevisionDiffView({ diff, sectionKey }: { diff: DiffModel; sectionKey: string }) {
  const basicChanged = diff.basic.filter((row) => row.changed).length;
  const factsChanged = diff.facts.filter((row) => row.changed).length;
  const mediaChanged = diff.media.filter((item) => item.state !== "kept").length;
  const floorsChanged = diff.floors.filter((row) => row.state !== "kept").length;
  const nothing =
    basicChanged === 0
    && factsChanged === 0
    && mediaChanged === 0
    && floorsChanged === 0
    && diff.otherCount === 0;

  return (
    <div className="space-y-3">
      {nothing ? <EmptyState label="本次提交与上一版内容一致" /> : null}
      <DiffSection changedCount={basicChanged} key={`${sectionKey}:basic`} title="基本信息">
        <DiffRowList rows={diff.basic} />
      </DiffSection>

      {diff.facts.length > 0 ? (
        <DiffSection changedCount={factsChanged} key={`${sectionKey}:facts`} title="详细信息">
          <DiffRowList rows={diff.facts} />
        </DiffSection>
      ) : null}

      {diff.media.length > 0 ? (
        <DiffSection changedCount={mediaChanged} key={`${sectionKey}:media`} title="图片">
          <div className="flex flex-wrap gap-3">
            {diff.media.map((item) => (
              <MediaThumb item={item} key={`${item.state}:${item.url}`} />
            ))}
          </div>
        </DiffSection>
      ) : null}

      {diff.floors.length > 0 ? (
        <DiffSection changedCount={floorsChanged} key={`${sectionKey}:floors`} title="楼层采集">
          <div className="space-y-2">
            {diff.floors.map((row) => (
              <FloorCard key={`${row.state}:${row.floor.levelCode}`} row={row} />
            ))}
          </div>
        </DiffSection>
      ) : null}

      {diff.otherCount > 0 ? (
        <p className="px-1 text-aux text-sub">另有 {diff.otherCount} 处其他变更未在上方分区展示。</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export function ReviewPage() {
  const [filter, setFilter] = useState("全部");
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const queue = useAsyncData(async (signal) => {
    const [revisions, operations, submissions] = await Promise.all([
      admin.listPendingRevisions(signal),
      admin.listAdminOperations<OperationalEventRow>(signal).catch(() => ({ items: [] as OperationalEventRow[] })),
      admin.listSubmissions(signal),
    ]);
    const items: QueueItem[] = [
      ...revisions.items.map((revision): QueueItem => ({
        kind: revision.type,
        id: revision.entityId,
        revisionId: revision.revisionId,
        title: revision.title,
        at: revision.submittedAt,
      })),
      ...operations.items
        .filter((e) => e.editorialStatus === "draft" || e.editorialStatus === "in_review")
        .map((e): QueueItem => ({ kind: "operation", id: e.id, title: e.title, at: e.createdAt, severity: e.severity })),
      ...submissions.items
        .filter((s) => s.status === "pending" || s.status === "in_review")
        .map((s): QueueItem => {
          const target = TARGET_TYPE_LABELS[s.targetType] ?? "内容";
          const from = text(s.submitterName);
          return {
            kind: "submission",
            id: s.id,
            title: from ? `${target} · ${from}` : target,
            at: s.createdAt,
          };
        }),
    ];
    return items.sort((a, b) => (a.at > b.at ? -1 : 1));
  }, []);

  // 设施类型编码 → 中文名，用于楼层采集里的设施行。
  const reference = useAsyncData(
    (signal) => admin.listReferenceData<ReferenceDataResponse>(signal).catch(() => null),
    [],
  );

  const isRevision = selected?.kind === "place" || selected?.kind === "facility" || selected?.kind === "merchant";
  const selectedRevisionId = selected && "revisionId" in selected ? selected.revisionId : null;

  // 待审修订的历史版本（含 content_json），用于结构化对比。
  const revisionDetail = useAsyncData(
    async (signal): Promise<{ kind: RevisionKind; revisions: Row[] } | null> => {
      if (!selected) return null;
      if (selected.kind === "place") {
        const data = await admin.getAdminPlace<PlaceDetailResponse>(selected.id, signal);
        return { kind: "place", revisions: data.revisions as Row[] };
      }
      if (selected.kind === "facility") {
        const data = await admin.getFacility<FacilityDetailResponse>(selected.id, signal);
        return { kind: "facility", revisions: data.revisions as Row[] };
      }
      if (selected.kind === "merchant") {
        const data = await admin.getMerchant<MerchantDetailResponse>(selected.id, signal);
        return { kind: "merchant", revisions: data.revisions as Row[] };
      }
      return null;
    },
    [selected?.kind ?? "", selected?.id ?? "", selectedRevisionId ?? ""],
  );

  if (queue.state.status === "loading") return <LoadingState label="加载审核队列…" />;
  if (queue.state.status === "error") return <ErrorBanner message={queue.state.message ?? "加载失败"} />;
  const items = queue.state.data!;
  const filters = ["全部", "地点", "设施", "商户", "运营事件", "用户提交"];
  const countOf = (f: string) => (f === "全部" ? items.length : items.filter((i) => KIND_META[i.kind].filter === f).length);
  const visible = filter === "全部" ? items : items.filter((i) => KIND_META[i.kind].filter === filter);

  const facilityTypeNames = new Map<string, string>();
  if (reference.state.status === "ready" && reference.state.data) {
    for (const type of reference.state.data.facilityTypes) {
      const code = text(type.code);
      if (code) facilityTypeNames.set(code, text(type.name));
    }
  }

  // 待审修订 vs 上一版已发布内容
  let diff: DiffModel | null = null;
  if (isRevision && revisionDetail.state.status === "ready" && revisionDetail.state.data) {
    const { kind, revisions } = revisionDetail.state.data;
    const current = revisions.find((r) => r.id === selectedRevisionId);
    const baseline = revisions.find((r) => r.editorial_status === "approved");
    if (current) diff = buildDiff(kind, current, baseline, facilityTypeNames);
  }

  async function decide(decision: "approve" | "reject") {
    if (!selected) return;
    if (decision === "reject" && !note.trim()) { setError("驳回时请填写审核意见"); return; }
    setBusy(true);
    setError("");
    try {
      if (selected.kind === "operation") {
        await admin.reviewOperation(selected.id, { decision, note: note.trim() || undefined });
      } else if (selected.kind === "submission") {
        await admin.reviewSubmission(selected.id, { decision: decision === "approve" ? "accept" : "reject", note: note.trim() || undefined });
      } else {
        if (!selected.revisionId) throw new Error("数据异常，无法提交审核");
        await admin.reviewRevision(selected.kind, selected.revisionId, { decision, note: note.trim() || undefined });
      }
      setSelected(null);
      setNote("");
      queue.reload();
    } catch (err) {
      setError(errorMessage(err, "审核操作失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {filters.map((f) => (
          <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {f} {countOf(f)}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-[420px_1fr] items-start gap-4">
        {/* 队列 */}
        <Panel padded={false}>
          <div className="divide-y divide-line">
            {visible.map((item) => {
              const itemRevisionId = "revisionId" in item ? item.revisionId : null;
              const active = selected?.kind === item.kind
                && selected.id === item.id
                && itemRevisionId === selectedRevisionId;
              return (
                <button
                  key={`${item.kind}:${item.id}:${itemRevisionId ?? "entity"}`}
                  className={`flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors ${active ? "bg-primary-container/60" : "hover:bg-page"}`}
                  onClick={() => { setSelected(item); setNote(""); setError(""); }}
                  type="button"
                >
                  <Pill className="mt-0.5">{KIND_META[item.kind].label}</Pill>
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-ink">{item.title}</p>
                    <p className="text-label text-sub">{fmtRelative(item.at)}</p>
                  </div>
                </button>
              );
            })}
            {visible.length === 0 ? <div className="p-5"><EmptyState label="队列已清空，没有待审核内容" /></div> : null}
          </div>
        </Panel>

        {/* 详情 */}
        <Panel padded={false} className="min-h-[420px]">
          {!selected ? (
            <div className="p-5"><EmptyState label="从左侧队列选择一条待审核内容" /></div>
          ) : (
            <div className="space-y-5 p-5">
              <div>
                <div className="flex items-center gap-2.5">
                  <Pill tone="info">{KIND_META[selected.kind].label}{selected.kind === "submission" ? "" : "修订"}</Pill>
                  <h2 className="text-card">{selected.title}</h2>
                </div>
                <p className="mt-1.5 text-aux text-sub">
                  {isRevision && revisionDetail.state.status === "loading"
                    ? "加载修订内容…"
                    : diff?.meta || `提交于 ${fmtDateTime(selected.at)}`}
                </p>
              </div>

              {isRevision ? (
                diff ? (
                  <RevisionDiffView diff={diff} sectionKey={`${selected.kind}:${selectedRevisionId ?? selected.id}`} />
                ) : revisionDetail.state.status === "error" ? (
                  <ErrorBanner message={revisionDetail.state.message ?? "修订内容加载失败"} />
                ) : revisionDetail.state.status === "ready" ? (
                  <EmptyState label="没有找到这条修订的内容" />
                ) : null
              ) : selected.kind === "operation" ? (
                <div className="flex items-center gap-2 text-body text-sub">
                  严重程度：<Pill tone={selected.severity === "critical" ? "error" : selected.severity === "warning" ? "warning" : "info"}>{SEVERITY_LABELS[selected.severity] ?? selected.severity}</Pill>
                  <Link className="text-primary" to={`/admin/operations/${selected.id}`}>查看事件详情 ›</Link>
                </div>
              ) : (
                <div className="text-body text-sub">
                  用户提交在用户提交页逐字段处理。
                  <Link className="ml-2 text-primary" to="/admin/submissions">前往处理 ›</Link>
                </div>
              )}

              <TextArea label="审核意见（驳回时必填）" onChange={setNote} placeholder="填写审核意见…" rows={3} value={note} />
              <ErrorBanner message={error} />
              <div className="flex justify-end gap-3">
                <GhostButton danger disabled={busy} onClick={() => decide("reject")}>驳回</GhostButton>
                <PrimaryButton disabled={busy} onClick={() => decide("approve")}>
                  {busy ? "处理中…" : "✓ 审核通过"}
                </PrimaryButton>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
