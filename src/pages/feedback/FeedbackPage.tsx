import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { PhotoPicker } from "../../components/ui/PhotoPicker";
import { SearchInput } from "../../components/ui/SearchInput";
import { createSubmission } from "../../lib/api/public";
import type { FeedbackType, SubmissionTargetType } from "../../../shared/submission-contract";
import {
  buildPlaceTargets,
  buildStopTargets,
  feedbackCampusOptions,
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
  const { addSubmission } = useSubmissionsLog();
  // 反馈不要求登录。登录了就自动署名并可溯源，没登录则匿名，昵称随便填（可留空）。
  const signedIn = auth?.status === "signed_in" && auth.user !== null;
  const [nickname, setNickname] = useState("");

  const [type, setType] = useState<FeedbackType>("correction");
  // 选中项整条留下来：baseRevisionId 直接取自它，不必再回头按 id 查一遍
  // （独立地点的 poiKey 带 place: 前缀，回查楼宇列表会漏）。
  const [selected, setSelected] = useState<FeedbackTargetResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const targetRequired = type !== "new_place";
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

  const uploading = uploads.photos.some((photo) => photo.status === "uploading");
  const canSubmit = content.trim().length >= 5
    && (!targetRequired || selected !== null)
    && !uploading
    && !submitting;

  const resetTarget = () => {
    setSelected(null);
    setPickerOpen(false);
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
      const result = await createSubmission({
        targetType: typeConfig.targetType,
        targetId: targetRequired ? selected!.targetId : null,
        baseRevisionId,
        payload: {
          submissionKind: "feedback",
          feedbackType: type,
          description: content.trim(),
        },
        // 上传失败的照片不在 mediaIds 里，文字提交照常进行
        photoMediaIds: uploads.mediaIds,
        // 登录时留空即由服务端回落到账号名；未登录时这就是唯一的自称，可以为 null。
        submitterName: nickname.trim() || null,
        submitterContact: contact.trim() || null,
      });
      addSubmission({
        id: result.id,
        targetType: typeConfig.targetType,
        targetId: selected?.targetId,
        targetName: selected?.name,
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

        {/* 关联目标：校区筛选 + 搜索，不再是一个几百项的下拉 */}
        {targetRequired ? (
          <>
            <h2 className="mt-5 text-emphasis">{isStop ? "关联站点" : "关联地点"}</h2>
            <button
              type="button"
              className="mt-2.5 flex w-full items-center justify-between rounded-2xl bg-surface px-4 py-3.5 shadow-card"
              onClick={() => setPickerOpen((open) => !open)}
            >
              <span className={selected ? "text-body text-ink" : "text-body text-sub"}>
                {selected ? feedbackTargetLabel(selected) : isStop ? "选择站点" : "搜索并选择地点"}
              </span>
              <ChevronRight size={16} className={`text-sub transition-transform ${pickerOpen ? "rotate-90" : ""}`} />
            </button>
            {pickerOpen ? (
              <div className="mt-2 rounded-2xl bg-surface p-3 shadow-card">
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={isStop ? "搜索站点名…" : "搜楼名、别名，或楼里的设施 / 商户…"}
                  autoFocus
                />
                {campusOptions.length > 2 ? (
                  <ChipRow className="mt-2.5">
                    {campusOptions.map((campus) => (
                      <Chip
                        key={campus.key || "all"}
                        active={campusKey === campus.key}
                        onClick={() => setCampusKey(campus.key)}
                      >
                        {campus.label}
                      </Chip>
                    ))}
                  </ChipRow>
                ) : null}
                <div className="mt-2 max-h-72 overflow-y-auto">
                  {page.items.map((item) => (
                    <button
                      key={item.targetId}
                      type="button"
                      className={`block w-full rounded-lg px-3 py-2.5 text-left active:bg-page ${
                        item.targetId === selected?.targetId ? "text-primary" : "text-ink"
                      }`}
                      onClick={() => {
                        setSelected(item);
                        setPickerOpen(false);
                        setQuery("");
                      }}
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
                {page.truncated ? (
                  <p className="mt-1 px-3 text-aux text-sub">
                    共 {page.total} 个匹配，仅显示前 {page.items.length} 个，继续输入可缩小范围。
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

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
        <p className="mt-3 text-center text-aux text-sub">提交后可在「我的 - 我的反馈」查看本机提交记录</p>
      </div>
    </div>
  );
}
