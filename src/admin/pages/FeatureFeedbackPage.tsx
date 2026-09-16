import { Star } from "lucide-react";
import { useState } from "react";
import * as admin from "../../lib/api/admin";
import type { FeatureFeedbackRow } from "../adminTypes";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  LoadingState,
  Panel,
  Pill,
  fmtDateTime,
  fmtRelative,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// 功能评分反馈：用户对功能页（搜索 / 校车）的 1-5 星评价。
//
// 纯运营数据——没有审核动作，这页只看。服务端支持 page/rating 查询参数，
// 这里仍沿用 SubmissionsPage 的做法：一次取回最近 200 条，客户端 chip 过滤，
// 组合筛选（页面 × 星级）不必来回打请求。
// ---------------------------------------------------------------------------

const PAGE_LABELS: Record<string, string> = {
  search: "搜索",
  shuttle: "校车",
};

const RATING_FILTERS = [5, 4, 3, 2, 1] as const;

function pageLabel(page: string): string {
  return PAGE_LABELS[page] ?? page;
}

/** 评分展示：实星 + 空星，低分（≤3）用警告色提示需要关注。 */
function RatingStars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} 星`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          size={13}
          className={
            value <= rating
              ? rating <= 3
                ? "fill-warning text-warning"
                : "fill-success text-success"
              : "text-line"
          }
        />
      ))}
    </span>
  );
}

export function FeatureFeedbackPage() {
  const [pageFilter, setPageFilter] = useState<string>("all");
  const [ratingFilter, setRatingFilter] = useState<number | "all">("all");
  const { state } = useAsyncData((signal) => admin.listFeatureFeedback(signal), []);

  if (state.status === "loading") return <LoadingState label="加载功能反馈…" />;
  if (state.status === "error") return <ErrorBanner message={state.message} />;
  const items = state.data.items;

  // page 是自由分组键：筛选 chips 从数据里取，出现新页面时这里自动多一个选项。
  const pages = [...new Set(items.map((item) => item.page))];
  const visible = items.filter((item) =>
    (pageFilter === "all" || item.page === pageFilter)
    && (ratingFilter === "all" || item.rating === ratingFilter));

  const average = items.length > 0
    ? (items.reduce((sum, item) => sum + item.rating, 0) / items.length).toFixed(1)
    : null;
  const lowCount = items.filter((item) => item.rating <= 3).length;

  const countOfPage = (page: string) =>
    page === "all" ? items.length : items.filter((item) => item.page === page).length;
  const countOfRating = (rating: number | "all") =>
    rating === "all" ? items.length : items.filter((item) => item.rating === rating).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={pageFilter === "all"} onClick={() => setPageFilter("all")}>
          全部页面 {countOfPage("all")}
        </Chip>
        {pages.map((page) => (
          <Chip key={page} active={pageFilter === page} onClick={() => setPageFilter(page)}>
            {pageLabel(page)} {countOfPage(page)}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={ratingFilter === "all"} onClick={() => setRatingFilter("all")}>
          全部评分 {countOfRating("all")}
        </Chip>
        {RATING_FILTERS.map((rating) => (
          <Chip key={rating} active={ratingFilter === rating} onClick={() => setRatingFilter(rating)}>
            {rating} 星 {countOfRating(rating)}
          </Chip>
        ))}
      </div>

      <Panel padded={false}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5 text-aux text-sub">
          <span>共 {items.length} 条</span>
          {average ? <span>平均 {average} 星</span> : null}
          {lowCount > 0 ? <span className="text-warning">低分（≤3 星）{lowCount} 条</span> : null}
          <span className="ml-auto">仅显示最近 200 条</span>
        </div>
        <div className="divide-y divide-line">
          {visible.map((item: FeatureFeedbackRow) => (
            <div key={item.id} className="flex items-start gap-3 px-5 py-3.5">
              <Pill tone="info" className="mt-0.5">{pageLabel(item.page)}</Pill>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <RatingStars rating={item.rating} />
                  <span className="text-label text-sub">{item.rating} 星</span>
                </div>
                {item.reason ? (
                  <p className="mt-1 text-body text-ink">{item.reason}</p>
                ) : (
                  <p className="mt-1 text-label text-sub">（未填写原因）</p>
                )}
              </div>
              <span className="shrink-0 text-label text-sub" title={fmtDateTime(item.createdAt)}>
                {fmtRelative(item.createdAt)}
              </span>
            </div>
          ))}
          {visible.length === 0 ? <div className="p-5"><EmptyState label="该筛选下暂无反馈" /></div> : null}
        </div>
      </Panel>
    </div>
  );
}
