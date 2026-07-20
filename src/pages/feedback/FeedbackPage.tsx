import { Camera, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { PageHeader } from "../../components/ui/PageHeader";
import { SearchInput } from "../../components/ui/SearchInput";
import { createSubmission } from "../../lib/api/public";
import type { SubmissionTargetType, TransitStop } from "../../lib/api/types";
import { useRelease } from "../../lib/release/ReleaseContext";
import { useIdentity } from "../../lib/storage/identity";
import { useSubmissionsLog } from "../../lib/storage/submissionsLog";

type FeedbackType = "correction" | "new_place" | "shuttle" | "other";

const FEEDBACK_TYPES: Array<{ key: FeedbackType; label: string; targetType: SubmissionTargetType }> = [
  { key: "correction", label: "信息纠错", targetType: "place" },
  { key: "new_place", label: "新增地点", targetType: "new_place" },
  { key: "shuttle", label: "校车问题", targetType: "transit_stop" },
  { key: "other", label: "其他", targetType: "place" },
];

/** M11 用户反馈。照片上传仅 UI（submissions 限 64KiB JSON）。 */
export function FeedbackPage() {
  const navigate = useNavigate();
  const { release } = useRelease();
  const [identity] = useIdentity();
  const { addSubmission } = useSubmissionsLog();

  const [type, setType] = useState<FeedbackType>("correction");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const buildings = useMemo(() => release?.buildings ?? [], [release]);
  const transitStops = useMemo(() => release?.manifest.transit.stops ?? [], [release]);
  const targetName = targetId
    ? type === "shuttle"
      ? (transitStops.find((stop) => stop.id === targetId)?.name ?? null)
      : (buildings.find((building) => building.poiKey === targetId)?.name ?? null)
    : null;

  const pickerResults = useMemo(() => {
    const query = pickerQuery.trim();
    if (type === "shuttle") {
      return (query ? transitStops.filter((stop) => stop.name.includes(query)) : transitStops).slice(0, 20);
    }
    return (query ? buildings.filter((building) => building.name.includes(query)) : buildings).slice(0, 20);
  }, [buildings, pickerQuery, transitStops, type]);

  const typeConfig = FEEDBACK_TYPES.find((item) => item.key === type)!;
  const targetRequired = type !== "new_place";
  const canSubmit = content.trim().length >= 5 && (!targetRequired || Boolean(targetId)) && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const title = content.trim().split("\n")[0].slice(0, 30);
    try {
      const result = await createSubmission({
        targetType: typeConfig.targetType,
        targetId: targetRequired ? targetId : null,
        payload: {
          feedbackType: type,
          description: content.trim(),
          photos: 0, // 照片上传仅 UI，未实际上传
        },
        submitterName: identity.name,
        submitterContact: contact.trim() || null,
      });
      addSubmission({
        id: result.id,
        targetType: typeConfig.targetType,
        targetId: targetId ?? undefined,
        targetName: targetName ?? undefined,
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
                setTargetId(null);
                setPickerOpen(false);
                setPickerQuery("");
              }}
            >
              {item.label}
            </Chip>
          ))}
        </ChipRow>

        {/* 关联地点 */}
        {targetRequired ? (
          <>
            <h2 className="mt-5 text-emphasis">{type === "shuttle" ? "关联站点" : "关联地点"}</h2>
            <button
              type="button"
              className="mt-2.5 flex w-full items-center justify-between rounded-2xl bg-surface px-4 py-3.5 shadow-card"
              onClick={() => setPickerOpen((open) => !open)}
            >
              <span className={targetName ? "text-body text-ink" : "text-body text-sub"}>
                {targetName ?? (type === "shuttle" ? "选择站点" : "选择地点")}
              </span>
              <ChevronRight size={16} className={`text-sub transition-transform ${pickerOpen ? "rotate-90" : ""}`} />
            </button>
            {pickerOpen ? (
              <div className="mt-2 rounded-2xl bg-surface p-3 shadow-card">
                <SearchInput value={pickerQuery} onChange={setPickerQuery} placeholder={type === "shuttle" ? "搜索站点…" : "搜索地点…"} />
                <div className="mt-2 max-h-56 overflow-y-auto">
                  {pickerResults.map((item) => {
                    const isStop = type === "shuttle";
                    const id = isStop ? (item as TransitStop).id : (item as (typeof buildings)[number]).poiKey;
                    const name = item.name;
                    const campusLabel = isStop ? null : (item as (typeof buildings)[number]).campusLabel;
                    return (
                    <button
                      key={id}
                      type="button"
                      className={`block w-full rounded-lg px-3 py-2.5 text-left text-body active:bg-page ${
                        id === targetId ? "font-medium text-primary" : "text-ink"
                      }`}
                      onClick={() => {
                        setTargetId(id);
                        setPickerOpen(false);
                        setPickerQuery("");
                      }}
                    >
                      {name}
                      {campusLabel ? <span className="ml-1.5 text-aux text-sub">{campusLabel}</span> : null}
                    </button>
                    );
                  })}
                  {pickerResults.length === 0 ? (
                    <div className="px-3 py-4 text-center text-aux text-sub">没有匹配的{type === "shuttle" ? "站点" : "地点"}</div>
                  ) : null}
                </div>
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

        {/* 补充照片（UI-only） */}
        <h2 className="mt-5 text-emphasis">补充照片（选填）</h2>
        <div className="mt-2.5 flex gap-3">
          <div className="grid h-20 w-20 place-items-center rounded-2xl bg-line/70 text-sub">
            <Camera size={26} />
          </div>
          {[0, 1].map((slot) => (
            <div
              key={slot}
              className="grid h-20 w-20 place-items-center rounded-2xl border-2 border-dashed border-line text-sub"
              title="照片上传暂未开放"
            >
              <Plus size={22} />
            </div>
          ))}
        </div>

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
