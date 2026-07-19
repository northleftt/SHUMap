import { CheckCircle2, CircleAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";
import * as admin from "../../lib/api/admin";
import { getCurrentRelease } from "../../lib/api/public";
import type { ReleaseManifest } from "../../lib/api/types";
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
// A5 发布中心（当前版本 + 发布表单 + A13 校验报告 + 回滚）
// ---------------------------------------------------------------------------

export function ReleasesPage({ canRollback = true }: { canRollback?: boolean }) {
  const { state, reload } = useAsyncData(async (signal) => {
    const [maps, release] = await Promise.all([
      admin.listMapVersions(signal),
      getCurrentRelease(signal).catch(() => null),
    ]);
    return { maps: maps.items, release };
  }, []);

  const [version, setVersion] = useState("");
  const [summary, setSummary] = useState("");
  const [selectedMapIds, setSelectedMapIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<admin.PublishReleaseResult | null>(null);
  const [rollbackId, setRollbackId] = useState("");
  const [rollbackMsg, setRollbackMsg] = useState("");

  if (state.status === "loading") return <LoadingState label="加载发布信息…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const release: ReleaseManifest | null = data.release;

  async function publish() {
    if (!version.trim()) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await admin.publishRelease({
        version: version.trim(),
        summary: summary.trim() || undefined,
        mapVersionIds: selectedMapIds.length > 0 ? selectedMapIds : undefined,
      });
      setResult(res);
      if (res.status === "active") {
        setVersion("");
        setSummary("");
        reload();
      }
    } catch (err) {
      setError(errorMessage(err, "发布失败"));
    } finally {
      setBusy(false);
    }
  }

  async function doRollback() {
    if (!rollbackId.trim()) return;
    setBusy(true);
    setRollbackMsg("");
    setError("");
    try {
      await admin.rollbackRelease(rollbackId.trim());
      setRollbackMsg(`已回滚到 ${rollbackId.trim()}`);
      setRollbackId("");
      reload();
    } catch (err) {
      setError(errorMessage(err, "回滚失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* 当前线上版本 */}
      <Panel padded={false}>
        {release ? (
          <div className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="text-aux text-sub">当前线上版本</p>
              <div className="mt-1.5 flex items-center gap-3">
                <span className="text-title">{release.release.version}</span>
                <Pill tone="ok" className="h-6 px-2.5">已上线</Pill>
              </div>
              <p className="mt-1.5 text-aux text-sub">发布于 {fmtDateTime(release.release.createdAt)}</p>
            </div>
            <div className="text-right">
              <p className="text-body text-ink">
                {release.places.length} 地点 · {release.facilities.length} 设施 · {release.merchants.length} 商户 · {release.maps.length} 地图版本 · {release.searchDocuments.length} 搜索文档
              </p>
              <p className="mt-1 font-mono text-label text-sub">{release.release.id}</p>
            </div>
          </div>
        ) : (
          <div className="p-5"><EmptyState label="尚无已发布版本" /></div>
        )}
      </Panel>

      <div className="grid grid-cols-2 items-start gap-4">
        {/* 发布新版本 */}
        <Panel title="发布新版本">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="版本号" onChange={setVersion} placeholder="如 v2026.07.19-1" value={version} />
              <Field label="摘要" onChange={setSummary} placeholder="本次发布说明" value={summary} />
            </div>
            <div>
              <p className="mb-2 text-label text-sub">地图版本（留空 = 使用全部已发布地图版本）</p>
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
                        {mapVersion.versionLabel} <span className="text-sub">({mapVersion.lifecycleStatus})</span>
                      </span>
                    </label>
                  );
                })}
                {data.maps.length === 0 ? <p className="col-span-2"><EmptyState label="暂无底图版本" /></p> : null}
              </div>
            </div>

            {/* A13 校验报告 */}
            {result ? (
              result.status === "active" ? (
                <div className="rounded-lg bg-success-bg p-4">
                  <p className="flex items-center gap-1.5 text-body font-semibold text-success">
                    <CheckCircle2 size={16} /> 校验通过，已发布
                  </p>
                  {result.validation ? (
                    <p className="mt-1.5 text-aux text-success">
                      {Object.entries(result.validation.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}
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
                    {result.validation?.warnings.map((w, i) => (
                      <p key={i} className="flex items-center gap-1.5 px-1 text-aux text-warning">
                        <TriangleAlert size={13} /> {w}
                      </p>
                    ))}
                  </div>
                  <p className="mt-2 text-label text-sub">修复后重新校验；warnings 记录后可继续</p>
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
            <div className="divide-y divide-line">
              {release ? (
                <div className="flex items-center justify-between px-5 py-3.5 text-body">
                  <span className="font-semibold">{release.release.version}</span>
                  <Pill tone="ok">当前线上</Pill>
                  <span className="text-aux text-sub">{fmtDateTime(release.release.createdAt)}</span>
                  <span className="text-aux text-sub">—</span>
                </div>
              ) : null}
            </div>
            <p className="px-5 py-3 text-label text-sub">历史版本列表接口暂未提供；回滚可指定任意已知 release ID。</p>
          </Panel>

          {canRollback ? (
            <Panel title="回滚">
              <div className="space-y-3">
                <p className="text-body text-sub">输入目标 release ID，将其重新置为当前生效版本。请谨慎操作，回滚会立即影响线上用户端内容。</p>
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <Field label="目标 Release ID" onChange={setRollbackId} placeholder="release_..." value={rollbackId} />
                  </div>
                  <GhostButton danger disabled={busy || !rollbackId.trim()} onClick={doRollback}>回滚</GhostButton>
                </div>
                {rollbackMsg ? <InfoNote tone="info">{rollbackMsg}</InfoNote> : null}
              </div>
            </Panel>
          ) : null}
        </div>
      </div>

      <InfoNote tone="info">
        发布流程：内容修订 → 审核通过 → 发布新版本（自动校验 + 生成搜索文档与 manifest）→ KV 切换 current_release 即时生效 · 失败可一键回滚至任意历史版本
      </InfoNote>
    </div>
  );
}
