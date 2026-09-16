import { Star, X } from "lucide-react";
import { useState } from "react";
import { submitFeatureFeedback } from "../../lib/api/public";
import { useLocalStore } from "../../lib/storage/localStore";
import { SheetModal } from "../ui/SheetModal";

/**
 * 「你觉得这个功能好用吗？」星级评分入口。
 *
 * 频率控制（shumap.feature-feedback，按 page 记）：提交过或点过 ✕ 的页面，
 * 入口整行消失，不再出现——没有 dwell 计时器、没有冷却天数，一次了结。
 * 提交成功的「感谢」状态在关弹卡时才落 submittedAt，否则成功提示会被
 * 入口消失连带卸载掉。
 *
 * 校验刻意只做「先选星级」这一件（禁用时说明原因）；长度等限制交给服务端，
 * 客户端不自造更严的规则（HANDOFF 6.5）。
 */

interface PageFeedbackState {
  submittedAt?: string;
  dismissedAt?: string;
}

type FeatureFeedbackStore = Record<string, PageFeedbackState>;

const STORE_KEY = "shumap.feature-feedback";
/** 低于等于这个评分时引导填原因（可选）。 */
const LOW_RATING_THRESHOLD = 3;
const STAR_VALUES = [1, 2, 3, 4, 5];

export function FeatureFeedback({
  page,
  prompt = "你觉得这个功能好用吗？",
}: {
  /** 评分归属的页面标识（如 search / shuttle），同时是频率控制的粒度。 */
  page: string;
  /** 入口行与弹卡的提问文案。 */
  prompt?: string;
}) {
  const [store, setStore] = useLocalStore<FeatureFeedbackStore>(STORE_KEY, {});
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const pageState = store[page];
  if (pageState?.submittedAt || pageState?.dismissedAt) return null;

  const dismiss = () => {
    setStore((prev) => ({
      ...prev,
      [page]: { ...prev[page], dismissedAt: new Date().toISOString() },
    }));
  };

  const closeSheet = () => {
    setOpen(false);
    // 提交过的在关弹卡这一刻才落 submittedAt：既保住「感谢」画面，
    // 也保证下次进来入口消失。
    if (done) {
      setStore((prev) => ({
        ...prev,
        [page]: { ...prev[page], submittedAt: new Date().toISOString() },
      }));
    }
  };

  const submit = async () => {
    if (rating === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const trimmed = reason.trim();
      await submitFeatureFeedback({ page, rating, ...(trimmed ? { reason: trimmed } : {}) });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-2xl bg-surface px-4 py-3 shadow-card">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left active:opacity-70"
          onClick={() => setOpen(true)}
        >
          <Star size={15} className="shrink-0 text-primary" />
          <span className="truncate text-aux text-sub">{prompt}</span>
        </button>
        <button
          type="button"
          aria-label="不再提示"
          title="不再提示"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-sub active:bg-page"
          onClick={dismiss}
        >
          <X size={13} />
        </button>
      </div>

      <SheetModal open={open} onClose={closeSheet} initialHeight={rating > 0 && rating <= LOW_RATING_THRESHOLD ? 0.5 : 0.38}>
        <div className="px-5 pb-6 pt-1">
          <h2 className="text-card text-ink">{prompt}</h2>
          {done ? (
            <div className="py-8 text-center">
              <p className="text-emphasis text-ink">感谢反馈！</p>
              <p className="mt-1.5 text-aux text-sub">我们会认真看待每一条评价</p>
              <button
                type="button"
                className="mt-5 w-full rounded-full bg-primary py-3 text-body font-semibold text-white active:bg-primary-pressed"
                onClick={closeSheet}
              >
                完成
              </button>
            </div>
          ) : (
            <>
              <div className="mt-4 flex justify-center gap-1.5">
                {STAR_VALUES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={`${value} 星`}
                    className="p-1.5 active:opacity-70"
                    onClick={() => setRating(value)}
                  >
                    <Star
                      size={30}
                      className={value <= rating ? "fill-warning text-warning" : "text-line"}
                    />
                  </button>
                ))}
              </div>
              {rating > 0 && rating <= LOW_RATING_THRESHOLD ? (
                <textarea
                  className="mt-4 h-24 w-full resize-none rounded-xl border border-line bg-page px-3.5 py-2.5 text-body text-ink outline-none placeholder:text-sub focus:border-primary"
                  placeholder="哪里不好用？告诉我们，方便改进（可选）"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              ) : null}
              {error ? <p className="mt-3 text-label text-error">{error}</p> : null}
              <button
                type="button"
                disabled={rating === 0 || busy}
                className="mt-4 w-full rounded-full bg-primary py-3 text-body font-semibold text-white active:bg-primary-pressed disabled:opacity-45"
                onClick={() => void submit()}
              >
                {busy ? "提交中…" : "提交"}
              </button>
              {rating === 0 ? (
                <p className="mt-2 text-center text-label text-sub">请先选择星级</p>
              ) : null}
            </>
          )}
        </div>
      </SheetModal>
    </>
  );
}
