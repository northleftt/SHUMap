import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type { OperationalEventRow } from "../adminTypes";
import {
  Chip,
  ErrorBanner,
  EVENT_TYPE_LABELS,
  GhostButton,
  InfoNote,
  LoadingState,
  OPERATIONAL_STATUS_LABELS,
  OPERATIONAL_STATUS_TONE,
  Panel,
  Pill,
  PrimaryButton,
  SEVERITY_LABELS,
  SEVERITY_TONE,
  TextArea,
  errorMessage,
  fmtDateTime,
  fmtDay,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A14 运营事件 · 事件详情与进展（updates 时间线 + 发布进展）
// ---------------------------------------------------------------------------

interface EventUpdate {
  id: string;
  status: string;
  message: string;
  createdBy?: string | null;
  createdAt: string;
}

const UPDATE_STATUS_META: Record<string, { label: string; tone: "info" | "warning" | "ok" }> = {
  progress: { label: "进展", tone: "info" },
  delayed: { label: "延期", tone: "warning" },
  resolved: { label: "恢复", tone: "ok" },
};

export function OperationDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();

  const { state, reload } = useAsyncData(async (signal) => {
    const list = await admin.listAdminOperations<OperationalEventRow & { targets?: Array<{ targetType: string; targetId: string }>; updates?: EventUpdate[] }>(signal);
    const event = list.items.find((e) => e.id === id);
    if (!event) throw new Error("事件不存在");
    return event;
  }, [id]);

  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"progress" | "delayed" | "resolved">("progress");
  const [expectedEndsAt, setExpectedEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (state.status === "loading") return <LoadingState label="加载事件…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const event = state.data!;
  const updates = (event.updates ?? []).slice().sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  const ended = event.operationalStatus === "resolved" || event.operationalStatus === "expired" || event.operationalStatus === "cancelled";

  async function publishUpdate() {
    if (!message.trim()) { setError("请填写进展内容"); return; }
    if (status === "delayed" && !expectedEndsAt.trim()) { setError("延期进展需要填写新的预计恢复时间"); return; }
    setBusy(true);
    setError("");
    try {
      await admin.createOperationUpdate(id, {
        status,
        message: message.trim(),
        expectedEndsAt: status === "delayed" ? new Date(expectedEndsAt).toISOString() : undefined,
      });
      setMessage("");
      setExpectedEndsAt("");
      setStatus("progress");
      reload();
    } catch (err) {
      setError(errorMessage(err, "发布进展失败（该端点可能尚未部署到生产环境）"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* 头部卡 */}
      <Panel padded={false}>
        <div className="flex items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <Pill tone={SEVERITY_TONE[event.severity] ?? "info"}>
                {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType} · {SEVERITY_LABELS[event.severity] ?? event.severity}
              </Pill>
              <h2 className="text-card">{event.title}</h2>
            </div>
            <p className="mt-1.5 text-aux text-sub">
              {fmtDay(event.startsAt)} 起{event.expectedEndsAt ? ` · 预计 ${fmtDay(event.expectedEndsAt)} 恢复` : ""}
            </p>
            {event.targets && event.targets.length > 0 ? (
              <div className="mt-2.5 flex items-center gap-1.5">
                <span className="text-label text-sub">关联对象</span>
                {event.targets.map((target, i) => (
                  <Pill key={i} tone="info">{target.targetId}</Pill>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <Pill tone={OPERATIONAL_STATUS_TONE[event.operationalStatus] ?? "neutral"} className="h-6 px-2.5">
              {OPERATIONAL_STATUS_LABELS[event.operationalStatus] ?? event.operationalStatus}
            </Pill>
            {!ended ? (
              <GhostButton
                onClick={() => {
                  setStatus("resolved");
                  document.getElementById("update-message")?.focus();
                }}
              >
                提前结束
              </GhostButton>
            ) : null}
            <GhostButton onClick={() => navigate("/admin/operations")}>返回列表</GhostButton>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-2 items-start gap-4">
        {/* 发布新进展 */}
        <Panel title="发布新进展">
          <div className="space-y-4">
            <TextArea
              label=""
              onChange={setMessage}
              placeholder="向用户同步的最新进展，如：维修人员已进场、预计提前一天恢复…"
              rows={4}
              value={message}
            />
            <div>
              <p className="mb-2 text-label text-sub">进展类型</p>
              <div className="flex gap-2">
                {(["progress", "delayed", "resolved"] as const).map((s) => (
                  <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
                    {UPDATE_STATUS_META[s].label}
                  </Chip>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-label text-sub">预计恢复时间{status === "delayed" ? "（延期必填）" : "（选填）"}</span>
              <input
                className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-body outline-none focus:border-primary"
                onChange={(e) => setExpectedEndsAt(e.target.value)}
                type="datetime-local"
                value={expectedEndsAt}
              />
            </label>
            <ErrorBanner message={error} />
            <PrimaryButton className="w-full" disabled={busy || ended} onClick={publishUpdate}>
              {busy ? "发布中…" : ended ? "事件已结束" : "发布进展"}
            </PrimaryButton>
            <InfoNote tone="info">
              进展随事件公开：移动端 M6 详情与 M8 摘要卡展示最新一条；「恢复」类型进展会自动建议结束事件。
            </InfoNote>
          </div>
        </Panel>

        {/* 进展时间线 */}
        <Panel title="进展时间线" padded={false}>
          <div className="space-y-4 p-5">
            {updates.map((update) => {
              const meta = UPDATE_STATUS_META[update.status] ?? UPDATE_STATUS_META.progress;
              return (
                <div key={update.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className={`mt-1 h-2.5 w-2.5 rounded-full ${update.status === "resolved" ? "bg-success" : update.status === "delayed" ? "bg-warning" : "bg-primary"}`} />
                    <span className="w-px flex-1 bg-line" />
                  </div>
                  <div className="min-w-0 flex-1 pb-1">
                    <div className="flex items-center gap-2 text-aux text-sub">
                      <span>{fmtDateTime(update.createdAt)}</span>
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                    </div>
                    <p className="mt-1.5 rounded-lg bg-page px-3.5 py-2.5 text-body text-ink">{update.message}</p>
                  </div>
                </div>
              );
            })}
            <div className="flex gap-3">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-sub" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-aux text-sub">
                  <span>{fmtDateTime(event.createdAt)}</span>
                  <Pill>系统</Pill>
                </div>
                <p className="mt-1.5 rounded-lg bg-page px-3.5 py-2.5 text-body text-ink">事件创建（{event.editorialStatus === "approved" ? "已审核通过" : "待审核"}）</p>
              </div>
            </div>
            {updates.length === 0 ? (
              <p className="text-aux text-sub">尚无人工进展；最新进展会同步显示在移动端事件详情顶部。</p>
            ) : null}
            <InfoNote tone="warning">
              「延期」类型进展会要求填写新的预计恢复时间并更新事件的 expected_ends_at；「恢复」类型发布后事件自动标记为已解决（resolved_at）。
            </InfoNote>
          </div>
        </Panel>
      </div>
    </div>
  );
}
