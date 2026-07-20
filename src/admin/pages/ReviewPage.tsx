import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type {
  OperationalEventRow,
  PlaceDetailResponse,
  SubmissionRow,
} from "../adminTypes";
import {
  Chip,
  EditorialPill,
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
// A3 审核中心（左队列 + 右 diff / 审核操作）
// ---------------------------------------------------------------------------

type QueueItem =
  | { kind: "place"; id: string; revisionId: string | null; title: string; at: string }
  | { kind: "facility"; id: string; revisionId: string | null; title: string; at: string }
  | { kind: "merchant"; id: string; revisionId: string | null; title: string; at: string }
  | { kind: "operation"; id: string; title: string; at: string; severity: string }
  | { kind: "submission"; id: string; title: string; at: string };

const KIND_META: Record<QueueItem["kind"], { label: string; filter: string }> = {
  place: { label: "地点", filter: "地点" },
  facility: { label: "设施", filter: "设施" },
  merchant: { label: "商户", filter: "商户" },
  operation: { label: "运营", filter: "运营事件" },
  submission: { label: "提交", filter: "用户提交" },
};

interface RevisionDiff {
  field: string;
  before: string;
  after: string;
}

const DIFF_FIELDS: Array<{ key: string; label: string }> = [
  { key: "display_name", label: "名称" },
  { key: "summary", label: "简介" },
  { key: "description", label: "详细描述" },
];

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
        .map((s): QueueItem => ({ kind: "submission", id: s.id, title: `${s.targetType} · ${s.targetId ?? "新地点"}`, at: s.createdAt })),
    ];
    return items.sort((a, b) => (a.at > b.at ? -1 : 1));
  }, []);

  // 地点修订 diff 详情
  const placeDetail = useAsyncData(
    (signal) =>
      selected?.kind === "place"
        ? admin.getAdminPlace<PlaceDetailResponse>(selected.id, signal)
        : Promise.resolve(null),
    [selected?.kind === "place" ? selected.id : ""],
  );

  if (queue.state.status === "loading") return <LoadingState label="加载审核队列…" />;
  if (queue.state.status === "error") return <ErrorBanner message={queue.state.message ?? "加载失败"} />;
  const items = queue.state.data!;
  const filters = ["全部", "地点", "设施", "商户", "运营事件", "用户提交"];
  const countOf = (f: string) => (f === "全部" ? items.length : items.filter((i) => KIND_META[i.kind].filter === f).length);
  const visible = filter === "全部" ? items : items.filter((i) => KIND_META[i.kind].filter === filter);

  // 地点 diff：当前 in_review 修订 vs 上一条 approved
  let diffs: RevisionDiff[] = [];
  let revisionMeta = "";
  if (selected?.kind === "place" && placeDetail.state.status === "ready" && placeDetail.state.data) {
    const revisions = placeDetail.state.data.revisions as Array<Record<string, unknown>>;
    const current = revisions.find((r) => r.id === selected.revisionId);
    const baseline = revisions.find((r) => r.editorial_status === "approved");
    if (current) {
      revisionMeta = `修订 #${current.revision_no} · 提交于 ${fmtDateTime(String(current.created_at ?? ""))}`;
      diffs = DIFF_FIELDS.map((f) => ({
        field: f.label,
        before: String(baseline?.[f.key] ?? "（空）"),
        after: String(current[f.key] ?? "（空）"),
      })).filter((d) => d.before !== d.after);
      if (diffs.length === 0) diffs = DIFF_FIELDS.map((f) => ({ field: f.label, before: String(baseline?.[f.key] ?? "（空）"), after: String(current[f.key] ?? "（空）") }));
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (!selected) return;
    if (decision === "reject" && !note.trim()) { setError("驳回时请填写审核意见"); return; }
    setBusy(true);
    setError("");
    try {
      if (selected.kind === "operation") {
        await admin.reviewOperation(selected.id, { decision });
      } else if (selected.kind === "submission") {
        await admin.reviewSubmission(selected.id, { decision: decision === "approve" ? "accept" : "reject", note: note.trim() || undefined });
      } else {
        if (!selected.revisionId) throw new Error("缺少修订 ID（列表接口未返回 currentRevisionId，待后端部署后可用）");
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
              const selectedRevisionId = selected && "revisionId" in selected ? selected.revisionId : null;
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
                  {selected.kind === "place" && placeDetail.state.status === "loading" ? "加载修订详情…" : revisionMeta || `提交于 ${fmtDateTime(selected.at)}`}
                </p>
              </div>

              {selected.kind === "place" ? (
                diffs.length > 0 ? (
                  <div>
                    <p className="mb-2 text-emphasis">变更内容</p>
                    <div className="divide-y divide-line rounded-lg bg-page">
                      {diffs.map((diff) => (
                        <div key={diff.field} className="grid grid-cols-[90px_1fr_24px_1fr] items-center gap-2 px-4 py-2.5 text-body">
                          <span className="text-sub">{diff.field}</span>
                          <span className="truncate text-sub">{diff.before}</span>
                          <span className="text-center text-sub">→</span>
                          <span className="truncate font-medium text-ink">{diff.after}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : placeDetail.state.status === "ready" ? (
                  <EmptyState label="该修订没有可对比的字段变更" />
                ) : null
              ) : selected.kind === "operation" ? (
                <div className="flex items-center gap-2 text-body text-sub">
                  严重程度：<Pill tone={selected.severity === "critical" ? "error" : selected.severity === "warning" ? "warning" : "info"}>{SEVERITY_LABELS[selected.severity] ?? selected.severity}</Pill>
                  <Link className="text-primary" to={`/admin/operations/${selected.id}`}>查看事件详情 ›</Link>
                </div>
              ) : selected.kind === "submission" ? (
                <div className="text-body text-sub">
                  用户提交在用户提交页逐字段处理。
                  <Link className="ml-2 text-primary" to="/admin/submissions">前往处理 ›</Link>
                </div>
              ) : (
                <p className="text-body text-sub">设施 / 商户修订的字段级 diff 待详情接口补充；当前可按整体通过或驳回。</p>
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
