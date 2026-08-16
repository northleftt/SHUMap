import { CheckCircle2, CircleAlert, MinusCircle, PencilLine, PlusCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import { getAdminReleaseSummary, type AdminReleaseSummary } from "../../lib/api/public";
import type { MapLifecycleStatus, PendingChangeKind, PendingChangeRow, PendingEntityType } from "../../lib/api/admin";
import { useAuth } from "../AuthContext";
import { usePendingRelease } from "../PendingReleaseContext";
import {
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
  fmtDateTime,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// 发布中心（待发布改动 + 当前版本 + 发布表单 + 校验报告 + 回滚）
// ---------------------------------------------------------------------------

const ENTITY_LABEL: Record<PendingEntityType, string> = {
  place: "地点",
  facility: "设施",
  merchant_outlet: "商户",
  transit_stop: "校车站点",
  map_version: "地图版本",
};

const CHANGE_LABEL: Record<PendingChangeKind, string> = {
  added: "新增",
  changed: "修改",
  removed: "移除",
};

const CHANGE_ICON: Record<PendingChangeKind, typeof PlusCircle> = {
  added: PlusCircle,
  changed: PencilLine,
  removed: MinusCircle,
};

const CHANGE_TONE: Record<PendingChangeKind, string> = {
  added: "text-success",
  changed: "text-primary",
  removed: "text-error",
};

/** 能点进去改的那几类给链接；站点在校车页里，地图版本在地图页里。 */
function editPathOf(row: PendingChangeRow): string | null {
  if (row.change === "removed") return null;
  if (row.entityType === "place") return `/admin/content/places/${row.entityId}`;
  if (row.entityType === "facility") return `/admin/content/facilities/${row.entityId}`;
  if (row.entityType === "merchant_outlet") return `/admin/content/merchants/${row.entityId}`;
  if (row.entityType === "transit_stop") return "/admin/transit";
  return "/admin/maps";
}

/**
 * 待发布改动清单。
 *
 * 「地图数据只来自 release」这条约定的代价是：后台改完，用户端要等下一次发版才会
 * 变。此前后台没有任何地方说这件事，改完看不到效果时无从判断是自己填错了还是只差
 * 一次发版。这块面板就是回答后者，并且顺手把「差哪些」列清楚。
 */
function PendingChangesPanel({ pending }: { pending: admin.PendingReleaseChanges | null }) {
  if (!pending) {
    return (
      <Panel title="待发布改动">
        <InfoNote>正在比对当前数据与线上版本…</InfoNote>
      </Panel>
    );
  }
  if (!pending.hasPendingChanges) {
    return (
      <Panel title="待发布改动">
        <p className="flex items-center gap-1.5 text-body text-success">
          <CheckCircle2 size={16} />
          没有待发布的改动，线上内容与后台一致。
        </p>
      </Panel>
    );
  }

  const grouped = new Map<PendingEntityType, PendingChangeRow[]>();
  for (const row of pending.changes) {
    grouped.set(row.entityType, [...(grouped.get(row.entityType) ?? []), row]);
  }

  return (
    <Panel title={`待发布改动 · ${pending.total} 项`}>
      <div className="space-y-4">
        <InfoNote tone="warning">
          以下改动已经保存在后台，但<span className="font-semibold">用户端还看不到</span>——地图与搜索的数据只来自已发布版本。
          下面发一个新版本即可生效。
          {pending.release ? `当前线上版本 ${pending.release.version}，发布于 ${fmtDateTime(pending.release.activatedAt)}。` : "目前还没有任何已发布版本。"}
        </InfoNote>

        {[...grouped.entries()].map(([entityType, rows]) => (
          <div key={entityType}>
            <p className="mb-1.5 text-label text-sub">{ENTITY_LABEL[entityType]} · {rows.length} 项</p>
            <div className="divide-y divide-line rounded-lg bg-page">
              {rows.map((row) => {
                const Icon = CHANGE_ICON[row.change];
                const path = editPathOf(row);
                return (
                  <div className="flex items-center gap-2.5 px-3 py-2" key={`${row.entityType}:${row.entityId}`}>
                    <Icon className={CHANGE_TONE[row.change]} size={14} />
                    <span className={`w-10 shrink-0 text-label ${CHANGE_TONE[row.change]}`}>{CHANGE_LABEL[row.change]}</span>
                    <span className="min-w-0 flex-1 truncate text-body text-ink">{row.displayName}</span>
                    {path ? (
                      <Link className="shrink-0 text-aux font-medium text-primary hover:underline" to={path}>查看 ›</Link>
                    ) : (
                      <span className="shrink-0 text-label text-sub">已从后台移除</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** 地图版本生命周期状态的中文文案。 */
const MAP_STATUS_LABEL: Record<MapLifecycleStatus, string> = {
  published: "当前使用",
  ready: "就绪",
  archived: "已归档",
  draft: "草稿",
  rejected: "已拒绝",
};

/** 校验统计项的中文文案；未列出的键不展示。 */
const COUNT_LABEL: Record<string, string> = {
  places: "地点",
  facilities: "设施",
  merchants: "商户",
  maps: "地图版本",
  locations: "位置",
};

function countsSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([key]) => key in COUNT_LABEL)
    .map(([key, value]) => `${COUNT_LABEL[key]} ${value}`)
    .join(" · ");
}

const LOCATION_ROLE_LABEL: Record<string, string> = {
  primary_display: "主要展示位置",
  footprint: "建筑轮廓",
  centroid: "中心点",
  main_entrance: "主入口",
  accessible_entrance: "无障碍入口",
  navigation_target: "导航终点",
  service_position: "服务位置",
  boarding_point: "候车点",
  alighting_point: "下车点（旧）",
  event_location: "事件位置",
  impact_area: "影响范围",
  route_shape: "路线",
  other: "其他位置",
};

function mapBindingEditPath(issue: admin.ReleaseMapBindingIssue): string | null {
  if (issue.entityType === "place") return `/admin/content/places/${issue.entityId}`;
  if (issue.entityType === "facility") return `/admin/content/facilities/${issue.entityId}`;
  if (issue.entityType === "merchant_outlet") return `/admin/content/merchants/${issue.entityId}`;
  if (issue.entityType === "transit_stop") return "/admin/transit";
  return null;
}

function mapBindingIssueText(issue: admin.ReleaseMapBindingIssue): string {
  const currentMap = [issue.currentMapCampusName, issue.currentMapVersionLabel].filter(Boolean).join(" · ")
    || issue.currentMapVersionId
    || "未绑定地图版本";
  const selectedMap = [issue.selectedMapCampusName, issue.selectedMapVersionLabel].filter(Boolean).join(" · ")
    || issue.selectedMapVersionId
    || "本次发布未选择对应地图";
  return `${issue.entityName} · ${LOCATION_ROLE_LABEL[issue.role] ?? issue.role}：当前绑定「${currentMap}」，本次选择「${selectedMap}」`;
}

/** 历史列表里的 release 状态（releases.status 的取值）。 */
const RELEASE_STATUS_META: Record<string, { label: string; tone: "ok" | "warning" | "error" | "info" | "neutral" }> = {
  active: { label: "当前线上", tone: "ok" },
  superseded: { label: "已被替换", tone: "neutral" },
  validating: { label: "校验中", tone: "info" },
  ready: { label: "待激活", tone: "info" },
  publishing: { label: "发布中", tone: "info" },
  validation_failed: { label: "校验失败", tone: "error" },
  failed: { label: "发布失败", tone: "error" },
};

function HistoryStatusPill({ status }: { status: string }) {
  const meta = RELEASE_STATUS_META[status] ?? { label: status, tone: "neutral" as const };
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

export function ReleasesPage() {
  const { hasPermission } = useAuth();
  const canRollback = hasPermission("rollback:release");
  // 与侧栏小黄点同一份数据：两处说法不一致会比没有提示更糟。
  const { pending, reload: reloadPending } = usePendingRelease();
  // 当前版本走 getAdminReleaseSummary 而不是完整解析：坏快照必须仍能进这个页面，
  // 否则「发一版新的把快照重写」这条唯一的自救路径会被它要修的东西挡住。
  const { state, reload } = useAsyncData(async (signal) => {
    const [maps, release, history] = await Promise.all([
      admin.listMapVersions(signal),
      getAdminReleaseSummary(signal),
      // 历史列表拉取失败不该挡住发版表单（比如老 Worker 还没部署新端点），
      // 单独兜成空列表。
      admin.listReleaseHistory(signal).catch(() => []),
    ]);
    return { maps: maps.items, release, history };
  }, []);

  const [version, setVersion] = useState("");
  const [summary, setSummary] = useState("");
  const [selectedMapIds, setSelectedMapIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<admin.PublishReleaseResult | null>(null);
  const [rollbackMsg, setRollbackMsg] = useState("");

  if (state.status === "loading") return <LoadingState label="加载发布信息…" />;
  if (state.status === "error") return <ErrorBanner message={state.message} />;
  const data = state.data;
  const release: AdminReleaseSummary | null = data.release;

  async function publish() {
    if (!version.trim()) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await admin.publishRelease({
        version: version.trim(),
        summary: summary.trim() || null,
        reason: null,
        mapVersionIds: selectedMapIds,
      });
      setResult(res);
      if (res.status === "active") {
        setVersion("");
        setSummary("");
        reload();
        // 发版成功后清单应当立刻变空，小黄点也跟着灭掉。不重算的话侧栏会继续
        // 提示「有改动待发版」，而那件事刚刚已经做完了。
        reloadPending();
      }
    } catch (err) {
      // 校验失败时协调器用 422 + { id, status, validation } 应答（不是 { error } 信封），
      // ApiError.body 保留原始 payload，这里还原成校验报告渲染明细。
      const report = validationFailure(err);
      if (report) setResult(report);
      else setError(errorMessage(err, "发布失败"));
    } finally {
      setBusy(false);
    }
  }

  // 从历史列表点选回滚，替代从前的手输版本 ID：回滚立刻影响全体用户，
  // 手输错一位就是事故；看着列表选 + confirm 二次确认。
  async function doRollback(row: admin.ReleaseHistoryRow) {
    if (busy || !row.rollbackEligible) return;
    const ok = window.confirm(`回滚到 ${row.version}（${row.id}）？\n当前线上版本会立即被替换，影响全体用户。`);
    if (!ok) return;
    setBusy(true);
    setRollbackMsg("");
    setError("");
    try {
      await admin.rollbackRelease(row.id, { reason: null });
      setRollbackMsg(`已回滚到 ${row.version}`);
      reload();
      // 回滚换掉了 active release，比对的基准也就换了：回到旧版本后，本来已发布的
      // 内容重新变成「待发布」。不重算清单会停在回滚前的说法。
      reloadPending();
    } catch (err) {
      setError(errorMessage(err, "回滚失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* 待发布改动放在最上面：进这个页面最常见的问题就是「我改的东西为什么没生效」，
          答案得第一眼看到，而不是翻到页面下半部分。 */}
      <PendingChangesPanel pending={pending} />

      {/* 当前线上版本 */}
      <Panel padded={false}>
        {release ? (
          <div className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="text-aux text-sub">当前线上版本</p>
              <div className="mt-1.5 flex items-center gap-3">
                <span className="text-title">{release.version}</span>
                <Pill tone={release.incompatibleReason ? "warning" : "ok"} className="h-6 px-2.5">
                  {release.incompatibleReason ? "客户端读不动" : "已上线"}
                </Pill>
              </div>
              <p className="mt-1.5 text-aux text-sub">发布于 {fmtDateTime(release.createdAt)}</p>
            </div>
            <div className="text-right">
              <p className="text-body text-ink">
                {release.counts.places} 地点 · {release.counts.facilities} 设施 · {release.counts.merchants} 商户 · {release.counts.maps} 地图版本
              </p>
            </div>
          </div>
        ) : (
          <div className="p-5"><EmptyState label="尚无已发布版本" /></div>
        )}
      </Panel>

      {/* 快照与客户端契约不兼容：用户端此刻打不开地图，发一版新的即可重写快照。
          这条提示要在发布表单上方，因为它就是此刻该做的事。 */}
      {release?.incompatibleReason ? (
        <InfoNote tone="warning">
          当前线上快照客户端解析失败，用户端地图打不开：{release.incompatibleReason}
          。用下面的表单发一版新的即可重写快照恢复（无需改动内容）。
        </InfoNote>
      ) : null}

      <div className="grid grid-cols-2 items-start gap-4">
        {/* 发布新版本 */}
        <Panel title="发布新版本">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="版本号" onChange={setVersion} placeholder="如 v2026.07.19-1" value={version} />
              <Field label="摘要" onChange={setSummary} placeholder="本次发布说明" value={summary} />
            </div>
            <div>
              <p className="mb-2 text-label text-sub">地图版本（不选则使用全部已发布的地图版本）</p>
              <div className="grid grid-cols-2 gap-2">
                {data.maps.map((mapVersion) => {
                  const checked = selectedMapIds.includes(mapVersion.id);
                  return (
                    <label
                      key={mapVersion.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-body ${
                        checked ? "border-primary bg-primary-container" : "border-line"
                      }`}
                    >
                      <input
                        checked={checked}
                        className="accent-primary"
                        onChange={() =>
                          setSelectedMapIds((cur) =>
                            cur.includes(mapVersion.id) ? cur.filter((id) => id !== mapVersion.id) : [...cur, mapVersion.id],
                          )
                        }
                        type="checkbox"
                      />
                      <span className="min-w-0 truncate">
                        {mapVersion.versionLabel}{" "}
                        <span className="text-sub">（{MAP_STATUS_LABEL[mapVersion.lifecycleStatus]}）</span>
                      </span>
                    </label>
                  );
                })}
                {data.maps.length === 0 ? <p className="col-span-2"><EmptyState label="暂无底图版本" /></p> : null}
              </div>
            </div>

            {/* 校验报告 */}
            {result ? (
              result.status === "active" ? (
                <div className="rounded-lg bg-success-bg p-4">
                  <p className="flex items-center gap-1.5 text-body font-semibold text-success">
                    <CheckCircle2 size={16} /> 校验通过，已发布
                  </p>
                  {result.validation ? (
                    <p className="mt-1.5 text-aux text-success">
                      {countsSummary(result.validation.counts)}
                    </p>
                  ) : null}
                  {result.validation && result.validation.warnings.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {result.validation.warnings.map((w, i) => (
                        <p key={i} className="flex items-center gap-1.5 text-aux text-warning">
                          <TriangleAlert size={13} /> {w}（警告，不阻塞）
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-lg bg-error-bg p-4">
                  <p className="flex items-center gap-1.5 text-body font-semibold text-error">
                    <CircleAlert size={16} /> 校验失败 · {result.validation?.errors.length ?? 0} 个错误阻断发布
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {result.validation?.errors.map((e, i) => (
                      <p key={i} className="rounded-md bg-white/60 px-3 py-2 text-body text-error">✕ {e}</p>
                    ))}
                    {result.validation?.mapBindingIssues?.length ? (
                      <div className="space-y-1.5 rounded-md bg-white/60 px-3 py-2">
                        <p className="text-aux font-semibold text-error">需要迁移到本次发布地图的位置</p>
                        {result.validation.mapBindingIssues.map((issue) => {
                          const path = mapBindingEditPath(issue);
                          return (
                            <div className="flex items-start gap-2 text-aux text-error" key={issue.anchorId}>
                              <span className="mt-0.5">✕</span>
                              <span className="min-w-0 flex-1">{mapBindingIssueText(issue)}</span>
                              {path ? <Link className="shrink-0 font-medium text-primary hover:underline" to={path}>前往修复 ›</Link> : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {result.validation?.warnings.map((w, i) => (
                      <p key={i} className="flex items-center gap-1.5 px-1 text-aux text-warning">
                        <TriangleAlert size={13} /> {w}
                      </p>
                    ))}
                  </div>
                  <p className="mt-2 text-label text-sub">修复以上错误后可重新发布</p>
                </div>
              )
            ) : null}

            <ErrorBanner message={error} />
            <PrimaryButton className="w-full" disabled={busy || !version.trim()} onClick={publish}>
              {busy ? "校验并发布中…" : "校验并发布"}
            </PrimaryButton>
          </div>
        </Panel>

        {/* 历史版本 + 回滚 */}
        <div className="space-y-4">
          <Panel title="历史版本" padded={false}>
            {/* 含失败尝试（validation_failed / failed）：它们是排障线索，不是噪音。 */}
            <div className="max-h-[26rem] divide-y divide-line overflow-y-auto">
              {data.history.length === 0 ? (
                <div className="px-5 py-6">
                  <EmptyState label="暂无历史版本（或历史接口不可用）" />
                </div>
              ) : data.history.map((row) => (
                <div className="flex items-center justify-between gap-3 px-5 py-3 text-body" key={row.id}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{row.version}</span>
                      <HistoryStatusPill status={row.status} />
                    </div>
                    <p className="mt-0.5 truncate text-aux text-sub" title={row.id}>
                      {row.createdAt ? fmtDateTime(row.createdAt) : "—"}
                      {row.summary ? ` · ${row.summary}` : ""}
                      {row.createdBy ? ` · ${row.createdBy}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {row.status === "active" ? <span className="text-aux text-success">当前线上</span> : null}
                    {canRollback && row.rollbackEligible && row.status !== "active" ? (
                      <GhostButton danger disabled={busy} onClick={() => doRollback(row)}>回滚到此版</GhostButton>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {canRollback ? (
            <Panel title="回滚说明">
              <div className="space-y-3">
                <p className="text-body text-sub">
                  在上方历史列表中点「回滚到此版」。回滚会立即影响所有用户看到的内容，操作前需二次确认；
                  只有点亮过（active / superseded）的版本才可回滚，失败的废尝试不可选。
                </p>
                {rollbackMsg ? <InfoNote tone="info">{rollbackMsg}</InfoNote> : null}
              </div>
            </Panel>
          ) : null}
        </div>
      </div>

    </div>
  );
}

/**
 * 校验失败（422）使用 { id, status:'validation_failed', validation } 响应体，和常规 { error } 信封不同。
 * 从 ApiError.body 里取回来，供上方校验报告分支渲染；不是这个形状则返回 null 走通用错误。
 */
function validationFailure(err: unknown): admin.PublishReleaseResult | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const body = err.body as admin.PublishReleaseResult | undefined;
  if (!body || typeof body !== "object" || body.status !== "validation_failed") return null;
  const validation = body.validation;
  if (!validation || !Array.isArray(validation.errors)) return null;
  return body;
}
