import { BookOpenText, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  GUIDE_DISMISS_KEY,
  GUIDE_SLUG,
  GUIDE_URL,
  type GuideSummary,
  dismissStamp,
  guideSubtitle,
  parseGuideSummary,
  shouldShowGuideBanner,
} from "../../lib/guideEntry";

/**
 * 返校指南入口条：开学期间悬浮在地图顶端。
 *
 * 「什么时候出现」由后台的发布状态决定，不再单独配一套档期：
 * 发布 = 出现，下线 = 消失。这样运营只需要记一件事，而且和指南自己的
 * 审核/发布流是同一个开关 —— 不会出现「内容下线了但入口还在」。
 *
 * 显示判断在 lib/guideEntry.ts，那边有单测覆盖；这里只负责取数与渲染。
 */

function readDismissed(): string {
  try {
    return localStorage.getItem(GUIDE_DISMISS_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDismissed(value: string): void {
  try {
    localStorage.setItem(GUIDE_DISMISS_KEY, value);
  } catch {
    /* 隐私模式下 localStorage 会抛错。关不掉总比整页崩掉好。 */
  }
}

export function GuideBanner() {
  const [guide, setGuide] = useState<GuideSummary | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  useEffect(() => {
    const controller = new AbortController();
    // 未发布时返回 404，静默处理 —— 没有指南就是没有入口，不是错误。
    fetch(`/api/public/guide/${GUIDE_SLUG}`, { signal: controller.signal, credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const summary = parseGuideSummary(payload);
        if (summary) setGuide(summary);
      })
      .catch(() => {
        /* 离线或接口异常：不显示入口，地图本身照常可用 */
      });
    return () => controller.abort();
  }, []);

  if (!guide || !shouldShowGuideBanner(guide, dismissed)) return null;
  const stamp = dismissStamp(guide.revisionNo);

  return (
    <div className="pointer-events-auto flex items-center gap-2.5 rounded-2xl bg-primary px-3.5 py-2.5 text-white shadow-floating">
      <BookOpenText size={18} className="shrink-0" />
      <a href={GUIDE_URL} className="min-w-0 flex-1 text-white no-underline">
        <p className="truncate text-body font-semibold leading-tight">{guide.title}</p>
        <p className="truncate text-label text-white/75">{guideSubtitle(guide)}</p>
      </a>
      <button
        type="button"
        aria-label="关闭返校指南入口"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
        onClick={() => {
          writeDismissed(stamp);
          setDismissed(stamp);
        }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
