import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import {
  arrayValue,
  jsonObject,
  nullablePositiveInteger,
  nullableSingleTextObject,
  nullableString,
  objectValue,
  oneOf,
  optionalString,
  requiredString,
  stringValue,
} from "../../lib/dataContract";
import type {
  FacilityDetailResponse,
  MerchantDetailResponse,
  OperationalEventRow,
  PlaceDetailResponse,
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
import { locationDraftFromApi } from "../components/LocationEditor";
import { readMedia } from "../components/MediaPanel";

// ---------------------------------------------------------------------------
// A3 审核中心（左队列 + 右结构化对比 / 审核操作）
//
// 右侧把待审修订和上一版已发布内容按基本信息、详细信息和图片分区对照。
// ---------------------------------------------------------------------------

type RevisionKind = "place" | "facility" | "merchant";

type QueueItem =
  | { kind: RevisionKind; id: string; revisionId: string | null; title: string; at: string }
  | { kind: "operation"; id: string; title: string; at: string; severity: string };

const KIND_META: Record<QueueItem["kind"], { label: string; filter: string }> = {
  place: { label: "地点", filter: "地点" },
  facility: { label: "设施", filter: "设施" },
  merchant: { label: "商户", filter: "商户" },
  operation: { label: "运营", filter: "运营事件" },
};

const EMPTY_TEXT = "未填写";

// ---------------------------------------------------------------------------
// 修订内容解析（content_json 及各 *_json 列都是文本，需先解析）
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function text(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  return stringValue(value, field).trim();
}

function nestedText(raw: unknown, key: string, field: string): string {
  return nullableSingleTextObject(raw, field, key).trim();
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

interface DiffModel {
  meta: string;
  basic: DiffRow[];
  facts: DiffRow[];
  media: MediaItem[];
  otherCount: number;
}

const PLACE_CONTENT_KEYS = new Set([
  "detail",
  "address",
]);

const PLACE_DETAIL_KEYS = new Set([
  "facts",
  "media",
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

/** 地点详细信息统一存储为 detail.facts。 */
function placeFacts(content: Row): Map<string, string> {
  const facts = new Map<string, string>();
  const detail = objectValue(content.detail, "place_revisions.content_json.detail");
  for (const [index, raw] of arrayValue(detail.facts, "place_revisions.content_json.detail.facts").entries()) {
    const field = `place_revisions.content_json.detail.facts[${index}]`;
    const fact = objectValue(raw, field);
    const label = requiredString(fact.label, `${field}.label`).trim();
    if (facts.has(label)) throw new Error(`${field}.label duplicates ${JSON.stringify(label)}`);
    facts.set(label, stringValue(fact.value, `${field}.value`).trim());
  }
  const address = text(content.address, "place_revisions.content_json.address");
  if (address) facts.set("地址", address);
  return facts;
}

function fieldFacts(content: Row, fields: Array<[string, string]>): Map<string, string> {
  const facts = new Map<string, string>();
  for (const [label, key] of fields) {
    const value = text(content[key], `content_json.${key}`);
    if (value) facts.set(label, value);
  }
  return facts;
}

function menuText(content: Row): string {
  if (content.menu === undefined) return "";
  return arrayValue(content.menu, "merchant_revisions.content_json.menu")
    .map((item, index) => requiredString(
      objectValue(item, `merchant_revisions.content_json.menu[${index}]`).name,
      `merchant_revisions.content_json.menu[${index}].name`,
    ).trim())
    .join("、");
}

function mediaUrls(kind: RevisionKind, content: Row): string[] {
  const value = kind === "place"
    ? objectValue(content.detail, "place_revisions.content_json.detail").media
    : content.media;
  if (value === undefined) return [];
  const mediaField = kind === "place"
    ? "place_revisions.content_json.detail.media"
    : `${kind}_revisions.content_json.media`;
  const urls = arrayValue(value, mediaField).map((item, index) => {
    const field = `${mediaField}[${index}]`;
    return requiredString(objectValue(item, field).url, `${field}.url`).trim();
  });
  if (new Set(urls).size !== urls.length) {
    throw new Error(`${kind}_revisions.content_json.media contains duplicate URLs`);
  }
  return urls;
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
      before.detail === undefined ? {} : objectValue(before.detail, "baseline content_json.detail"),
      objectValue(after.detail, "current content_json.detail"),
      detailKnown,
    );
  }
  return count;
}

function aliasesText(structure: Row, field: string, optional: boolean): string {
  if (optional && structure.aliases === undefined) return "";
  return arrayValue(structure.aliases, field)
    .map((value, index) => requiredString(value, `${field}[${index}]`))
    .join("、");
}

function validateLocations(structure: Row, field: string): void {
  arrayValue(structure.locations, `${field}.locations`).forEach((location, index) => {
    locationDraftFromApi(objectValue(location, `${field}.locations[${index}]`), index);
  });
}

function validateStructure(kind: RevisionKind, structure: Row): void {
  const field = `${kind}_revisions.structure_json`;
  if (kind === "place") {
    requiredString(structure.kindId, `${field}.kindId`);
    nullableString(structure.campusId, `${field}.campusId`);
    nullableString(structure.parentPlaceId, `${field}.parentPlaceId`);
    nullableString(structure.stableCode, `${field}.stableCode`);
    aliasesText(structure, `${field}.aliases`, false);
    if (structure.building !== null) {
      const building = objectValue(structure.building, `${field}.building`);
      nullableString(building.buildingCode, `${field}.building.buildingCode`);
      nullableString(building.managingOrganizationId, `${field}.building.managingOrganizationId`);
      oneOf(building.publicAccessLevel, `${field}.building.publicAccessLevel`, ["public", "restricted", "private", "unknown"] as const);
    }
  } else if (kind === "facility") {
    requiredString(structure.facilityTypeId, `${field}.facilityTypeId`);
    nullableString(structure.hostPlaceId, `${field}.hostPlaceId`);
    nullableString(structure.floorId, `${field}.floorId`);
    nullableString(structure.indoorSpaceId, `${field}.indoorSpaceId`);
    nullablePositiveInteger(structure.quantity, `${field}.quantity`);
    oneOf(structure.operationalStatus, `${field}.operationalStatus`, ["available", "partially_available", "unavailable", "unknown"] as const);
  } else {
    nullableString(structure.organizationId, `${field}.organizationId`);
    nullableString(structure.hostPlaceId, `${field}.hostPlaceId`);
    nullableString(structure.floorId, `${field}.floorId`);
    nullableString(structure.indoorSpaceId, `${field}.indoorSpaceId`);
  }
  validateLocations(structure, field);
}

function validateContent(kind: RevisionKind, content: Row): void {
  if (kind === "place") {
    const detail = objectValue(content.detail, "place_revisions.content_json.detail");
    readMedia(detail.media);
    placeFacts(content);
    return;
  }
  if (content.media !== undefined) readMedia(content.media);
  const fields = kind === "facility" ? FACILITY_CONTENT_FIELDS : MERCHANT_CONTENT_FIELDS;
  fieldFacts(content, fields);
  if (kind === "merchant" && content.menu !== undefined) {
    arrayValue(content.menu, "merchant_revisions.content_json.menu").forEach((raw, index) => {
      const field = `merchant_revisions.content_json.menu[${index}]`;
      const item = objectValue(raw, field);
      requiredString(item.name, `${field}.name`);
      optionalString(item.price, `${field}.price`);
      optionalString(item.description, `${field}.description`);
    });
  }
}

export function buildDiff(
  kind: RevisionKind,
  current: Row,
  baseline: Row | undefined,
): DiffModel {
  const afterContent = jsonObject(current.content_json, `${kind}_revisions.content_json`);
  const beforeContent = baseline ? jsonObject(baseline.content_json, `${kind}_revisions.content_json`) : {};
  const afterStructure = jsonObject(current.structure_json, `${kind}_revisions.structure_json`);
  const beforeStructure = baseline ? jsonObject(baseline.structure_json, `${kind}_revisions.structure_json`) : {};
  validateContent(kind, afterContent);
  validateStructure(kind, afterStructure);
  if (baseline) {
    validateContent(kind, beforeContent);
    validateStructure(kind, beforeStructure);
  }
  const basic: DiffRow[] = [];
  const pushBasic = (label: string, before: string, after: string) => {
    basic.push({ label, before, after, changed: before !== after });
  };
  pushBasic(
    "名称",
    text(baseline?.display_name, `${kind}_revisions.display_name`),
    requiredString(current.display_name, `${kind}_revisions.display_name`).trim(),
  );

  let beforeFacts = new Map<string, string>();
  let afterFacts = new Map<string, string>();
  let otherCount = 0;

  if (kind === "place") {
    pushBasic("简介", text(baseline?.summary, "place_revisions.summary"), text(current.summary, "place_revisions.summary"));
    pushBasic("详细描述", text(baseline?.description, "place_revisions.description"), text(current.description, "place_revisions.description"));
    beforeFacts = baseline ? placeFacts(beforeContent) : new Map<string, string>();
    afterFacts = placeFacts(afterContent);
    otherCount = countOtherChanges(beforeContent, afterContent, PLACE_CONTENT_KEYS, PLACE_DETAIL_KEYS);
    for (const [label, key] of [["地点类型", "kindId"], ["校区", "campusId"], ["父地点", "parentPlaceId"], ["地点编号", "stableCode"]] as const) {
      pushBasic(label, text(beforeStructure[key], `place_revisions.structure_json.${key}`), text(afterStructure[key], `place_revisions.structure_json.${key}`));
    }
    pushBasic(
      "别名",
      aliasesText(beforeStructure, "place_revisions.structure_json.aliases", !baseline),
      aliasesText(afterStructure, "place_revisions.structure_json.aliases", false),
    );
  } else if (kind === "facility") {
    pushBasic(
      "服务时间",
      baseline ? nestedText(baseline.service_hours_json, "text", "facility_revisions.service_hours_json") : "",
      nestedText(current.service_hours_json, "text", "facility_revisions.service_hours_json"),
    );
    beforeFacts = baseline ? fieldFacts(beforeContent, FACILITY_CONTENT_FIELDS) : new Map<string, string>();
    afterFacts = fieldFacts(afterContent, FACILITY_CONTENT_FIELDS);
    otherCount = countOtherChanges(
      beforeContent,
      afterContent,
      new Set([...FACILITY_CONTENT_FIELDS.map(([, key]) => key), "detail", "media"]),
    );
    for (const [label, key] of [["设施类型", "facilityTypeId"], ["所属楼宇", "hostPlaceId"], ["楼层", "floorId"], ["室内空间", "indoorSpaceId"], ["运营状态", "operationalStatus"]] as const) {
      pushBasic(label, text(beforeStructure[key], `facility_revisions.structure_json.${key}`), text(afterStructure[key], `facility_revisions.structure_json.${key}`));
    }
  } else {
    pushBasic("分类", text(baseline?.business_type, "merchant_revisions.business_type"), text(current.business_type, "merchant_revisions.business_type"));
    pushBasic(
      "营业时间",
      baseline ? nestedText(baseline.opening_hours_json, "text", "merchant_revisions.opening_hours_json") : "",
      nestedText(current.opening_hours_json, "text", "merchant_revisions.opening_hours_json"),
    );
    pushBasic(
      "联系电话",
      baseline ? nestedText(baseline.contact_json, "phone", "merchant_revisions.contact_json") : "",
      nestedText(current.contact_json, "phone", "merchant_revisions.contact_json"),
    );
    beforeFacts = baseline ? fieldFacts(beforeContent, MERCHANT_CONTENT_FIELDS) : new Map<string, string>();
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
    for (const [label, key] of [["所属品牌", "organizationId"], ["所在地点", "hostPlaceId"], ["所在楼层", "floorId"], ["室内空间", "indoorSpaceId"]] as const) {
      pushBasic(label, text(beforeStructure[key], `merchant_revisions.structure_json.${key}`), text(afterStructure[key], `merchant_revisions.structure_json.${key}`));
    }
  }
  const beforeLocations = baseline ? arrayValue(beforeStructure.locations, `${kind}_revisions.structure_json.locations`) : [];
  const afterLocations = arrayValue(afterStructure.locations, `${kind}_revisions.structure_json.locations`);
  if (JSON.stringify(beforeLocations) !== JSON.stringify(afterLocations)) {
    pushBasic("地图位置", `${beforeLocations.length} 个`, `${afterLocations.length} 个`);
  }

  if (typeof current.revision_no !== "number" || !Number.isInteger(current.revision_no) || current.revision_no <= 0) {
    throw new Error(`${kind}_revisions.revision_no must be a positive integer`);
  }
  const revisionNo = String(current.revision_no);
  const submittedAt = text(current.submitted_at, `${kind}_revisions.submitted_at`)
    || requiredString(current.created_at, `${kind}_revisions.created_at`).trim();
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
    media: mediaDiff(baseline ? mediaUrls(kind, beforeContent) : [], mediaUrls(kind, afterContent)),
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

export function RevisionDiffView({ diff, sectionKey }: { diff: DiffModel; sectionKey: string }) {
  const basicChanged = diff.basic.filter((row) => row.changed).length;
  const factsChanged = diff.facts.filter((row) => row.changed).length;
  const mediaChanged = diff.media.filter((item) => item.state !== "kept").length;
  const nothing =
    basicChanged === 0
    && factsChanged === 0
    && mediaChanged === 0
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
    const [revisions, operations] = await Promise.all([
      admin.listPendingRevisions(signal),
      admin.listAdminOperations<OperationalEventRow>(signal),
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
    ];
    return items.sort((a, b) => (a.at > b.at ? -1 : 1));
  }, []);

  const isRevision = selected?.kind === "place" || selected?.kind === "facility" || selected?.kind === "merchant";
  const selectedRevisionId = selected && "revisionId" in selected ? selected.revisionId : null;

  // 待审修订的历史版本（含 content_json），用于结构化对比。
  const revisionDetail = useAsyncData(
    async (signal): Promise<{ diff: DiffModel } | null> => {
      if (!selected) return null;
      if (selected.kind !== "place" && selected.kind !== "facility" && selected.kind !== "merchant") return null;
      if (!selected.revisionId) throw new Error("Pending revision has no revision id");
      let revisions: Row[];
      if (selected.kind === "place") {
        const data = await admin.getAdminPlace<PlaceDetailResponse>(selected.id, signal);
        revisions = data.revisions as Row[];
      } else if (selected.kind === "facility") {
        const data = await admin.getFacility<FacilityDetailResponse>(selected.id, signal);
        revisions = data.revisions as Row[];
      } else {
        const data = await admin.getMerchant<MerchantDetailResponse>(selected.id, signal);
        revisions = data.revisions as Row[];
      }
      const current = revisions.find((revision) => revision.id === selected.revisionId);
      if (!current) throw new Error(`Revision ${selected.revisionId} does not exist in entity history`);
      const baseline = revisions.find((revision) => revision.editorial_status === "approved");
      return { diff: buildDiff(selected.kind, current, baseline) };
    },
    [selected?.kind ?? "", selected?.id ?? "", selectedRevisionId ?? ""],
  );

  if (queue.state.status === "loading") return <LoadingState label="加载审核队列…" />;
  if (queue.state.status === "error") return <ErrorBanner message={queue.state.message ?? "加载失败"} />;
  const items = queue.state.data!;
  const filters = ["全部", "地点", "设施", "商户", "运营事件"];
  const countOf = (f: string) => (f === "全部" ? items.length : items.filter((i) => KIND_META[i.kind].filter === f).length);
  const visible = filter === "全部" ? items : items.filter((i) => KIND_META[i.kind].filter === filter);

  const diff = revisionDetail.state.status === "ready" ? revisionDetail.state.data?.diff ?? null : null;

  async function decide(decision: "approve" | "reject") {
    if (!selected) return;
    if (decision === "reject" && !note.trim()) { setError("驳回时请填写审核意见"); return; }
    setBusy(true);
    setError("");
    try {
      if (selected.kind === "operation") {
        await admin.reviewOperation(selected.id, { decision, note: note.trim() || undefined });
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
                  <Pill tone="info">{KIND_META[selected.kind].label}修订</Pill>
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
              ) : null}

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
