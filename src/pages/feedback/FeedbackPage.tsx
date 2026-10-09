import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapCanvas, type MapViewWindow } from "../../components/map/MapCanvas";
import { MapPoiOverlay } from "../../components/map/MapPoiOverlay";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { PhotoPicker } from "../../components/ui/PhotoPicker";
import { SearchInput } from "../../components/ui/SearchInput";
import { createSubmission } from "../../lib/api/public";
import { ApiError } from "../../lib/api/client";
import { recordAnalyticsEvent, usePageView } from "../../lib/analytics";
import type { FeedbackSubmissionInput, FeedbackType, SubmissionTargetType } from "../../../shared/submission-contract";
import {
  buildPlaceTargets,
  buildStopTargets,
  feedbackCampusOptions,
  feedbackSubmitBlockReason,
  feedbackTargetLabel,
  filterFeedbackTargets,
  type FeedbackTargetResult,
} from "../../lib/feedback/targets";
import { usePhotoUploads } from "../../lib/photos/usePhotoUploads";
import { useRelease } from "../../lib/release/ReleaseContext";
import type { LoadedRelease } from "../../lib/release/mapData";
import { useOptionalAccountAuth } from "../../lib/auth/AccountAuthContext";
import { useSubmissionsLog } from "../../lib/storage/submissionsLog";

const FEEDBACK_TYPES: Array<{ key: FeedbackType; label: string; targetType: SubmissionTargetType }> = [
  { key: "correction", label: "信息纠错", targetType: "place" },
  { key: "new_place", label: "新增地点", targetType: "new_place" },
  { key: "shuttle", label: "校车问题", targetType: "transit_stop" },
  { key: "other", label: "其他", targetType: "place" },
];

/** 反馈最多 3 张照片，与 worker 的 MAX_SUBMISSION_PHOTOS 一致。 */
const MAX_PHOTOS = 3;

/** M11 用户反馈。照片经 POST /api/public/media 落隔离区，审核采纳后才公开。 */
export function FeedbackPage() {
  const releaseState = useRelease();
  if (releaseState.status === "loading") {
    return <div className="h-full bg-page"><LoadingState label="正在加载发布数据…" /></div>;
  }
  if (releaseState.status !== "ready") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseState.status === "empty" ? "反馈目标尚未发布" : "发布数据加载失败"}
          subtitle={releaseState.status === "empty" ? "当前没有可关联的地点与站点" : "请检查网络后重试"}
        />
      </div>
    );
  }
  return <ReadyFeedbackPage release={releaseState.release} />;
}

function ReadyFeedbackPage({ release }: { release: LoadedRelease }) {
  const navigate = useNavigate();
  const auth = useOptionalAccountAuth();
  usePageView("feedback");
  const { addSubmission } = useSubmissionsLog();
  // 反馈不要求登录。登录了就自动署名并可溯源，没登录则匿名，昵称随便填（可留空）。
  const signedIn = auth?.status === "signed_in" && auth.user !== null;
  const [nickname, setNickname] = useState("");

  const [type, setType] = useState<FeedbackType>("correction");
  // 选中项整条留下来：baseRevisionId 直接取自它，不必再回头按 id 查一遍
  // （独立地点的 poiKey 带 place: 前缀，回查楼宇列表会漏）。
  const [selected, setSelected] = useState<FeedbackTargetResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"map" | "list">("list");
  const [viewWindow, setViewWindow] = useState<MapViewWindow | null>(null);
  const [campusKey, setCampusKey] = useState("");
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const uploads = usePhotoUploads(MAX_PHOTOS);

  // 别名进搜索：搜「乐乎新楼」应当命中它的正式名。
  const aliasesByPlaceId = useMemo(
    () => new Map(release.manifest.places.map((place) => [place.id, place.aliases])),
    [release.manifest.places],
  );
  const placeTargets = useMemo(
    () => buildPlaceTargets(release.pois, aliasesByPlaceId),
    [release.pois, aliasesByPlaceId],
  );
  const stopTargets = useMemo(
    () => buildStopTargets(release.manifest.transit.stops, release.campuses),
    [release.manifest.transit.stops, release.campuses],
  );

  const typeConfig = FEEDBACK_TYPES.find((item) => item.key === type)!;
  const isNewPlace = type === "new_place";
  const isStop = type === "shuttle";
  const options = isStop ? stopTargets : placeTargets;
  const campusOptions = useMemo(
    () => feedbackCampusOptions(options, release.campuses),
    [options, release.campuses],
  );
  const page = useMemo(
    () => filterFeedbackTargets(options, { campusKey, query }),
    [options, campusKey, query],
  );
  const mapCampus = release.campuses.find((campus) => campus.key === campusKey) ?? release.campuses[0];
  const mapMatches = useMemo(
    () => filterFeedbackTargets(options, { campusKey: mapCampus.key, query, limit: options.length }).items,
    [options, mapCampus.key, query],
  );
  const mapTargetById = useMemo(
    () => new Map(mapMatches.map((item) => [item.targetId, item])),
    [mapMatches],
  );
  const mapPois = useMemo(
    () => release.pois.filter((poi) =>
      poi.campusKey === mapCampus.key
      && (isStop ? poi.entityType === "transit_stop" : poi.entityType === "building" || poi.entityType === "place")
      && mapTargetById.has(poi.entityId),
    ),
    [release.pois, mapCampus.key, isStop, mapTargetById],
  );
  const mapFeatureBindings = useMemo(
    () => mapPois.flatMap((poi) => poi.mapFeatureId && poi.sourceElementId
      ? [{ id: poi.mapFeatureId, sourceElementId: poi.sourceElementId }]
      : []),
    [mapPois],
  );
  const mapTargetByFeature = useMemo(
    () => new Map(mapPois.filter((poi) => poi.mapFeatureId).map((poi) => [poi.mapFeatureId!, poi.entityId])),
    [mapPois],
  );
  const mapTargetByPoiKey = useMemo(
    () => new Map(mapPois.map((poi) => [poi.poiKey, poi.entityId])),
    [mapPois],
  );
  const selectedMapPoi = mapPois.find((poi) => poi.entityId === selected?.targetId) ?? null;

  const chooseTarget = (item: FeedbackTargetResult) => {
    setSelected(item);
    setCampusKey(options.find((option) => option.targetId === item.targetId)?.campusKey ?? "");
    recordAnalyticsEvent({
      eventType: "popup_close",
      meta: { popup: "target_picker", feedbackType: type, selected: true },
    });
    setPickerOpen(false);
    setQuery("");
  };

  const uploading = uploads.photos.some((photo) => photo.status === "uploading");
  // 禁用理由要能说出口：光有布尔值就只能给一个灰按钮，用户猜不到差什么（见 targets.ts 注释）。
  const submitBlockReason = feedbackSubmitBlockReason({
    content,
    targetRequired: true,
    hasTarget: selected !== null,
    uploadingPhotoCount: uploads.photos.filter((photo) => photo.status === "uploading").length,
  });
  const blockReason = isNewPlace && submitBlockReason === "请先选择关联的地点或站点"
    ? "请先选择位置参考地点"
    : submitBlockReason;
  const canSubmit = blockReason === "" && !submitting;

  const resetTarget = () => {
    setSelected(null);
    setPickerOpen(false);
    setPickerMode("list");
    setCampusKey("");
    setQuery("");
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const title = content.trim().split("\n")[0].slice(0, 30);
    try {
      let baseRevisionId: string | null = null;
      if (typeConfig.targetType === "place") {
        if (!selected?.revisionId) throw new Error("所选地点已不在当前发布版本中，请重新选择");
        baseRevisionId = selected.revisionId;
      }
      const submission: FeedbackSubmissionInput = {
        targetType: typeConfig.targetType,
        targetId: isNewPlace ? null : selected!.targetId,
        baseRevisionId,
        payload: {
          submissionKind: "feedback",
          feedbackType: type,
          description: content.trim(),
          ...(isNewPlace && selected ? {
            locationReference: {
              placeId: selected.targetId,
              placeName: selected.name,
              campusLabel: selected.campusLabel,
            },
          } : {}),
        },
        // 上传失败的照片不在 mediaIds 里，文字提交照常进行
        photoMediaIds: uploads.mediaIds,
        // 登录时留空即由服务端回落到账号名；未登录时这就是唯一的自称，可以为 null。
        submitterName: nickname.trim() || null,
        submitterContact: contact.trim() || null,
      };
      let result;
      try {
        result = await createSubmission(submission);
      } catch (submitError) {
        // 本地 Vite 可代理尚未更新的线上 Worker。旧接口只认识 description，
        // 仅在它明确拒绝新字段时，把位置参考写进描述后重试一次。
        if (!isNewPlace || !selected || !(submitError instanceof ApiError)
          || submitError.status !== 400 || !submitError.message.includes("locationReference")) {
          throw submitError;
        }
        const locationLine = `位置参考：${feedbackTargetLabel(selected)}（地点 ID：${selected.targetId}）`;
        const fallbackDescription = `${locationLine}\n${content.trim()}`;
        if (fallbackDescription.length > 2_000) {
          throw new Error("反馈内容过长，请缩短后重试，以便保存位置参考");
        }
        result = await createSubmission({
          ...submission,
          payload: { submissionKind: "feedback", feedbackType: type, description: fallbackDescription },
        });
      }
      addSubmission({
        id: result.id,
        targetType: typeConfig.targetType,
        targetId: isNewPlace ? undefined : selected?.targetId,
        targetName: isNewPlace ? `参考位置：${selected?.name ?? ""}` : selected?.name,
        title: title || "反馈",
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="flex h-full flex-col bg-page">
        <PageHeader title="意见反馈" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-success-bg text-success">✓</div>
          <div className="text-card">提交成功</div>
          <p className="text-aux leading-relaxed text-sub">
            感谢反馈！提交记录已保存在本机，可在「我的 - 我的反馈」查看。
          </p>
          <button
            type="button"
            className="mt-3 rounded-full bg-primary px-8 py-2.5 text-body font-semibold text-white active:bg-primary-pressed"
            onClick={() => navigate("/profile")}
          >
            查看我的反馈
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-page">
      <PageHeader title="意见反馈" />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {/* 反馈类型 */}
        <h2 className="mt-2 text-emphasis">反馈类型</h2>
        <ChipRow className="mt-2.5">
          {FEEDBACK_TYPES.map((item) => (
            <Chip
              key={item.key}
              active={type === item.key}
              variant="outline"
              onClick={() => {
                setType(item.key);
                resetTarget();
              }}
            >
              {item.label}
            </Chip>
          ))}
        </ChipRow>

        {/* 新地点选择现有地点作位置参考；其余反馈选择关联目标。 */}
        <>
            <h2 className="mt-5 text-emphasis">{isNewPlace ? "位置参考地点" : isStop ? "关联站点" : "关联地点"}</h2>
            <button
              type="button"
              className="mt-2.5 flex w-full items-center justify-between rounded-2xl bg-surface px-4 py-3.5 shadow-card"
              onClick={() => {
                recordAnalyticsEvent({
                  eventType: pickerOpen ? "popup_close" : "popup_open",
                  meta: { popup: "target_picker", feedbackType: type },
                });
                setPickerOpen(!pickerOpen);
              }}
            >
              <span className={selected ? "text-body text-ink" : "text-body text-sub"}>
                {selected ? feedbackTargetLabel(selected) : isStop ? "选择站点" : isNewPlace ? "选择附近的现有地点" : "搜索并选择地点"}
              </span>
              <ChevronRight size={16} className={`text-sub transition-transform ${pickerOpen ? "rotate-90" : ""}`} />
            </button>
            {isNewPlace ? (
              <p className="mt-2 text-aux text-sub">选一个附近的现有地点作定位参考，再在反馈内容中说明新地点的准确位置。</p>
            ) : null}
            {pickerOpen ? (
              <div className="mt-2 rounded-2xl bg-surface p-3 shadow-card">
                <div className="mb-3 flex gap-2" role="tablist" aria-label="选择方式">
                  {(["map", "list"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={pickerMode === mode}
                      className={`flex-1 rounded-xl px-3 py-2 text-aux font-medium ${pickerMode === mode ? "bg-primary-container text-primary" : "bg-page text-sub"}`}
                      onClick={() => setPickerMode(mode)}
                    >
                      {mode === "map" ? "在图中选择" : "在列表中选择"}
                    </button>
                  ))}
                </div>
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={isStop ? "搜索站点名…" : "搜楼名、别名，或楼里的设施 / 商户…"}
                  autoFocus
                />
                {campusOptions.length > 2 ? (
                  <ChipRow className="mt-2.5">
                    {campusOptions.filter((campus) => pickerMode === "list" || campus.key !== "").map((campus) => (
                      <Chip
                        key={campus.key || "all"}
                        active={(pickerMode === "map" ? mapCampus.key : campusKey) === campus.key}
                        onClick={() => setCampusKey(campus.key)}
                      >
                        {campus.label}
                      </Chip>
                    ))}
                  </ChipRow>
                ) : null}
                {pickerMode === "map" ? (
                  <div className="mt-3">
                    <div className="relative h-[min(50vh,420px)] min-h-72 overflow-hidden rounded-xl" aria-label="选择关联位置的校园地图">
                      <MapCanvas
                        campus={mapCampus}
                        featureBindings={mapFeatureBindings}
                        matchedFeatureIds={mapFeatureBindings.map((binding) => binding.id)}
                        selectedFeatureId={selectedMapPoi?.mapFeatureId ?? null}
                        selectedPoint={selectedMapPoi?.markerPoint ?? null}
                        onSelectFeature={(featureId) => {
                          const item = mapTargetById.get(mapTargetByFeature.get(featureId) ?? "");
                          if (item) chooseTarget(item);
                        }}
                        onTapOverlayPoi={(poiKey) => {
                          const item = mapTargetById.get(mapTargetByPoiKey.get(poiKey) ?? "");
                          if (item) chooseTarget(item);
                        }}
                        onViewWindowChange={setViewWindow}
                        overlay={
                          <MapPoiOverlay
                            viewWindow={viewWindow}
                            pois={mapPois.filter((poi) => poi.markerPoint !== null)}
                            selectedPoiKey={selectedMapPoi?.poiKey ?? null}
                            onSelect={(poiKey) => {
                              const item = mapTargetById.get(mapTargetByPoiKey.get(poiKey) ?? "");
                              if (item) chooseTarget(item);
                            }}
                          />
                        }
                      />
                    </div>
                    <p className="mt-2 text-aux text-sub">点选地图上的楼宇或图钉；没有地图标注的地点可切换到列表选择。</p>
                    {mapPois.length === 0 ? <p className="mt-2 text-aux text-sub">当前校区或搜索条件下没有可点选的地图标注。</p> : null}
                  </div>
                ) : (
                  <div className="mt-2 max-h-72 overflow-y-auto">
                    {page.items.map((item) => (
                      <button
                        key={item.targetId}
                        type="button"
                        className={`block w-full rounded-lg px-3 py-2.5 text-left active:bg-page ${
                          item.targetId === selected?.targetId ? "text-primary" : "text-ink"
                        }`}
                        onClick={() => chooseTarget(item)}
                      >
                        <span className="text-body">{item.name}</span>
                        {item.campusLabel ? (
                          <span className="ml-1.5 text-aux text-sub">{item.campusLabel}</span>
                        ) : null}
                        {item.matchHint ? (
                          <span className="mt-0.5 block text-aux text-sub">{item.matchHint}</span>
                        ) : null}
                      </button>
                    ))}
                    {page.items.length === 0 ? (
                      <div className="px-3 py-4 text-center text-aux text-sub">
                        没有匹配的{isStop ? "站点" : "地点"}，换个关键词试试
                      </div>
                    ) : null}
                  </div>
                )}
                {pickerMode === "list" && page.truncated ? (
                  <p className="mt-1 px-3 text-aux text-sub">
                    共 {page.total} 个匹配，仅显示前 {page.items.length} 个，继续输入可缩小范围。
                  </p>
                ) : null}
              </div>
            ) : null}
        </>

        {/* 反馈内容 */}
        <h2 className="mt-5 text-emphasis">反馈内容</h2>
        <textarea
          className="mt-2.5 h-36 w-full resize-none rounded-2xl bg-surface p-4 text-body text-ink shadow-card outline-none placeholder:text-sub"
          placeholder={"请描述问题，如：位置有误、信息过时、\n设施已搬离…"}
          value={content}
          maxLength={2000}
          onChange={(event) => setContent(event.target.value)}
        />

        {/* 补充照片：即传即存隔离区，审核采纳后才公开 */}
        <h2 className="mt-5 text-emphasis">补充照片（选填，最多 {MAX_PHOTOS} 张）</h2>
        <div className="mt-2.5">
          <PhotoPicker
            onPick={uploads.addFiles}
            onRemove={uploads.remove}
            onRetry={uploads.retry}
            photos={uploads.photos}
            slotsLeft={uploads.slotsLeft}
          />
          {uploading ? <p className="mt-2 text-aux text-sub">照片上传完成后即可提交。</p> : null}
          {uploads.failedCount > 0 ? (
            <p className="mt-2 text-aux text-sub">
              有 {uploads.failedCount} 张照片上传失败，可点击重试；不重试也能直接提交文字反馈。
            </p>
          ) : null}
        </div>

        {/* 署名：登录与否都能提，区别只在能不能溯源 */}
        <h2 className="mt-5 text-emphasis">署名（选填）</h2>
        <input
          className="mt-2.5 w-full rounded-2xl bg-surface px-4 py-3.5 text-body text-ink shadow-card outline-none placeholder:text-sub"
          placeholder={signedIn ? `留空则用账号名「${auth?.user?.displayName ?? ""}」` : "如 张同学，留空则匿名"}
          value={nickname}
          maxLength={100}
          onChange={(event) => setNickname(event.target.value)}
        />
        <p className="mt-2 text-aux text-sub">
          {signedIn
            ? "已登录，这条反馈会关联你的账号，处理进度可追溯。"
            : "未登录也可以提交。登录后提交的反馈会关联账号，方便后续跟进。"}
        </p>

        {/* 联系方式 */}
        <h2 className="mt-5 text-emphasis">联系方式（选填，便于核实）</h2>
        <input
          className="mt-2.5 w-full rounded-2xl bg-surface px-4 py-3.5 text-body text-ink shadow-card outline-none placeholder:text-sub"
          placeholder="手机 / 邮箱"
          value={contact}
          maxLength={100}
          onChange={(event) => setContact(event.target.value)}
        />

        {error ? <p className="mt-3 text-aux text-error">{error}</p> : null}

        <button
          type="button"
          disabled={!canSubmit}
          className="mt-6 w-full rounded-full bg-primary py-3.5 text-body font-semibold text-white active:bg-primary-pressed disabled:opacity-40"
          onClick={handleSubmit}
        >
          {submitting ? "提交中…" : "提交反馈"}
        </button>
        {/* 按钮变灰时必须说出原因，否则用户只能对着灰按钮猜（见 targets.ts 的注释）。 */}
        <p className="mt-3 text-center text-aux text-sub">
          {blockReason || "提交后可在「我的 - 我的反馈」查看本机提交记录"}
        </p>
      </div>
    </div>
  );
}
