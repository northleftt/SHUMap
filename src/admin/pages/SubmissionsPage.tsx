import { useState } from "react";
import * as admin from "../../lib/api/admin";
import type { SubmissionRow } from "../adminTypes";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  GhostButton,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  TextArea,
  errorMessage,
  fmtDateTime,
  fmtRelative,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A9 用户提交 · 处理（队列 + 字段采纳 + 处理意见）
// ---------------------------------------------------------------------------

const STATUS_META: Record<string, { label: string; tone: "warning" | "ok" | "info" | "error" | "neutral" }> = {
  pending: { label: "待处理", tone: "warning" },
  in_review: { label: "待处理", tone: "warning" },
  accepted: { label: "已采纳", tone: "ok" },
  partially_accepted: { label: "部分采纳", tone: "info" },
  rejected: { label: "已驳回", tone: "error" },
};

const FILTERS = [
  { key: "todo", label: "待处理" },
  { key: "accepted", label: "已采纳" },
  { key: "partially_accepted", label: "部分采纳" },
  { key: "rejected", label: "已驳回" },
  { key: "all", label: "全部" },
] as const;

const TARGET_TYPE_LABELS: Record<string, string> = {
  place: "地点",
  facility: "设施",
  merchant_outlet: "商户",
  transit_stop: "校车",
  new_place: "新地点",
};

function safeParse(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 提取 payload 中可逐字段采纳的文本字段。 */
function payloadFields(payload: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  const fields: Array<{ key: string; label: string; value: string }> = [];
  const detail = payload.detail as Record<string, unknown> | undefined;
  const description = payload.description ?? detail?.description;
  const summary = payload.summary ?? detail?.summary;
  const feedbackType = payload.feedbackType;
  const collection = payload.collection as Record<string, unknown> | undefined;
  if (typeof feedbackType === "string" && feedbackType) fields.push({ key: "feedbackType", label: "反馈类型", value: feedbackType });
  if (typeof summary === "string" && summary) fields.push({ key: "summary", label: "摘要", value: summary });
  if (typeof description === "string" && description) fields.push({ key: "description", label: "问题描述", value: description });
  if (collection && typeof collection === "object") {
    for (const [key, label] of [["openHours", "开放时间"], ["phone", "联系电话"], ["organization", "所属单位"]] as const) {
      const value = collection[key];
      if (typeof value === "string" && value) fields.push({ key: `collection.${key}`, label, value });
    }
    if (Array.isArray(collection.floors)) fields.push({ key: "collection.floors", label: "楼层采集", value: `${collection.floors.length} 层` });
  }
  for (const [key, value] of Object.entries(payload)) {
    if (["detail", "collection", "description", "summary", "feedbackType", "photos"].includes(key)) continue;
    if (typeof value === "string" && value) fields.push({ key, label: key, value });
  }
  return fields;
}

export function SubmissionsPage() {
  const [filter, setFilter] = useState<string>("todo");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const { state, reload } = useAsyncData((signal) => admin.listSubmissions(signal), []);

  if (state.status === "loading") return <LoadingState label="加载用户提交…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const items = state.data!.items;

  const countOf = (key: string) => {
    if (key === "all") return items.length;
    if (key === "todo") return items.filter((s) => s.status === "pending" || s.status === "in_review").length;
    return items.filter((s) => s.status === key).length;
  };
  const visible = items.filter((s) => {
    if (filter === "all") return true;
    if (filter === "todo") return s.status === "pending" || s.status === "in_review";
    return s.status === filter;
  });

  const selected = items.find((s) => s.id === selectedId) ?? null;
  const selectedPayload = selected ? safeParse(selected.payloadJson) : {};
  const fields = selected ? payloadFields(selectedPayload) : [];
  const selectedMeta = selected ? (STATUS_META[selected.status] ?? STATUS_META.pending) : null;
  const selectedPending = selected ? selected.status === "pending" || selected.status === "in_review" : false;
  const canGenerateRevision = selected?.targetType === "place" && (
    selectedPayload.collection !== undefined || selectedPayload.detail !== undefined || selectedPayload.changes !== undefined
  );

  function select(submission: SubmissionRow) {
    setSelectedId(submission.id);
    setNote("");
    setError("");
    setAdopted(new Set(payloadFields(safeParse(submission.payloadJson)).map((f) => f.key)));
  }

  async function decide(decision: "accept" | "partial" | "reject") {
    if (!selected) return;
    if (decision === "reject" && !note.trim()) { setError("驳回时请填写处理意见"); return; }
    setBusy(true);
    setError("");
    try {
      const fieldDecisions = Object.fromEntries(fields.map((f) => [f.key, adopted.has(f.key) ? "adopt" : "skip"]));
      await admin.reviewSubmission(selected.id, {
        decision,
        note: note.trim() || undefined,
        fieldDecisions,
      });
      setSelectedId(null);
      reload();
    } catch (err) {
      setError(errorMessage(err, "处理失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} {countOf(f.key)}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-[400px_1fr] items-start gap-4">
        {/* 队列 */}
        <Panel padded={false}>
          <div className="divide-y divide-line">
            {visible.map((submission) => {
              const meta = STATUS_META[submission.status] ?? STATUS_META.pending;
              return (
                <button
                  key={submission.id}
                  className={`flex w-full items-start justify-between gap-3 px-5 py-3.5 text-left transition-colors ${
                    selectedId === submission.id ? "bg-primary-container/60" : "hover:bg-page"
                  }`}
                  onClick={() => select(submission)}
                  type="button"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <Pill className="mt-0.5">{TARGET_TYPE_LABELS[submission.targetType] ?? submission.targetType}</Pill>
                    <div className="min-w-0">
                      <p className="truncate text-body font-medium text-ink">{submission.targetId ?? "新地点建议"}</p>
                      <p className="text-label text-sub">{submission.submitterName || "匿名"} · {fmtRelative(submission.createdAt)}</p>
                    </div>
                  </div>
                  <Pill tone={meta.tone}>{meta.label}</Pill>
                </button>
              );
            })}
            {visible.length === 0 ? <div className="p-5"><EmptyState label="该状态下暂无提交" /></div> : null}
          </div>
          <p className="px-5 pb-4 font-mono text-label text-sub">targetType / targetId / submitter / status</p>
        </Panel>

        {/* 详情 */}
        <Panel padded={false} className="min-h-[420px]">
          {!selected ? (
            <div className="p-5"><EmptyState label="从左侧选择一条提交进行处理" /></div>
          ) : (
            <div className="space-y-5 p-5">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Pill tone="info">{TARGET_TYPE_LABELS[selected.targetType] ?? selected.targetType}反馈</Pill>
                    <h2 className="text-card">{selected.targetId ?? "新地点建议"}</h2>
                  </div>
                  {selectedMeta ? <Pill tone={selectedMeta.tone}>{selectedMeta.label}</Pill> : null}
                </div>
                <p className="mt-1.5 text-aux text-sub">
                  提交人 {selected.submitterName || "匿名"}{selected.submitterContact ? `（${selected.submitterContact}）` : ""} · {fmtDateTime(selected.createdAt)}
                </p>
              </div>

              <div>
                <p className="mb-2 text-emphasis">提交内容{selectedPending ? "（逐字段核对，勾选 = 采纳）" : ""}</p>
                {fields.length > 0 ? (
                  <div className="divide-y divide-line rounded-lg border border-line">
                    {fields.map((field) => (
                      <div key={field.key} className="flex items-center gap-3 px-4 py-2.5 text-body">
                        <span className="w-20 shrink-0 text-sub">{field.label}</span>
                        <span className="min-w-0 flex-1 text-ink">{field.value}</span>
                        {selectedPending ? (
                          <input
                            checked={adopted.has(field.key)}
                            className="h-4.5 w-4.5 accent-primary"
                            onChange={() =>
                              setAdopted((cur) => {
                                const next = new Set(cur);
                                if (next.has(field.key)) next.delete(field.key);
                                else next.add(field.key);
                                return next;
                              })
                            }
                            type="checkbox"
                          />
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState label="（无文字描述）" />
                )}
              </div>

              {selectedPending ? (
                <>
                  <TextArea label="处理意见（将随处理结果通知提交人）" onChange={setNote} placeholder="如 已电话与服务台核实…" rows={3} value={note} />
                  <ErrorBanner message={error} />
                  <div className="flex justify-end gap-3">
                    <GhostButton danger disabled={busy} onClick={() => decide("reject")}>驳回</GhostButton>
                    <GhostButton disabled={busy} onClick={() => decide("partial")}>部分采纳</GhostButton>
                    <PrimaryButton disabled={busy} onClick={() => decide("accept")}>
                      {busy ? "处理中…" : canGenerateRevision ? "全部采纳并生成修订" : "全部采纳"}
                    </PrimaryButton>
                  </div>
                  <p className="text-label leading-relaxed text-sub">
                    {canGenerateRevision
                      ? "采纳后会基于当前线上内容生成保留原字段的地点修订，并直接进入审核队列。"
                      : "处理结果会写入审核记录；当前反馈缺少可直接应用的结构化字段。"}
                  </p>
                </>
              ) : (
                <p className="text-body text-sub">该提交已于 {fmtDateTime(selected.reviewedAt)} 处理完成。</p>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
