import { useState } from "react";
import { getAnalyticsSummary } from "../../lib/api/admin";
import { Chip, EmptyState, ErrorBanner, LoadingState, Panel, useAsyncData } from "../components/primitives";

// 与 migrations-v2/0030_analytics_event_types.sql 的 CHECK 保持一致。
const EVENT_TYPE_LABELS: Record<string, string> = {
  map_view: "地图页浏览",
  poi_view: "POI 详情曝光",
  page_view: "页面浏览",
  search: "地图搜索",
  shuttle_query: "校车查询",
  dining_view: "就餐页浏览",
  popup_open: "弹层曝光",
  popup_close: "弹层关闭",
};

const DAY_OPTIONS = [7, 14, 30];

function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? eventType;
}

/** 埋点统计：窗口内事件类型汇总、按天拆分、POI 曝光榜。 */
export function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const { state } = useAsyncData((signal) => getAnalyticsSummary(days, signal), [days]);

  return (
    <div className="space-y-4">
      <Panel
        title="事件统计"
        action={
          <div className="flex gap-1.5">
            {DAY_OPTIONS.map((option) => (
              <Chip key={option} active={days === option} onClick={() => setDays(option)}>
                近 {option} 天
              </Chip>
            ))}
          </div>
        }
        padded={false}
      >
        {state.status === "loading" ? (
          <div className="p-5"><LoadingState label="加载埋点统计…" /></div>
        ) : state.status === "error" ? (
          <div className="p-5"><ErrorBanner message={state.message ?? "加载失败"} /></div>
        ) : state.data!.totals.length === 0 ? (
          <div className="p-5"><EmptyState label={`近 ${days} 天没有埋点事件`} /></div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-label text-sub">
                <th className="px-4 pb-2 pt-3 font-medium">事件类型</th>
                <th className="px-4 pb-2 pt-3 text-right font-medium">次数</th>
              </tr>
            </thead>
            <tbody>
              {state.data!.totals.map((row) => (
                <tr key={row.event_type} className="border-t border-line text-body">
                  <td className="px-4 py-2.5">{eventTypeLabel(row.event_type)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.event_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {state.status === "ready" && state.data!.topPlaces.length > 0 ? (
        <Panel title="POI 曝光榜（poi_view）" padded={false}>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-label text-sub">
                <th className="px-4 pb-2 pt-3 font-medium">地点</th>
                <th className="px-4 pb-2 pt-3 text-right font-medium">曝光次数</th>
              </tr>
            </thead>
            <tbody>
              {state.data!.topPlaces.map((row) => (
                <tr key={row.place_id} className="border-t border-line text-body">
                  <td className="px-4 py-2.5">{row.place_name ?? row.place_id}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.view_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {state.status === "ready" && state.data!.daily.length > 0 ? (
        <Panel title="按天拆分" padded={false}>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-label text-sub">
                <th className="px-4 pb-2 pt-3 font-medium">日期</th>
                <th className="px-4 pb-2 pt-3 font-medium">事件类型</th>
                <th className="px-4 pb-2 pt-3 text-right font-medium">次数</th>
              </tr>
            </thead>
            <tbody>
              {state.data!.daily.map((row) => (
                <tr key={`${row.day}:${row.event_type}`} className="border-t border-line text-body">
                  <td className="px-4 py-2.5 tabular-nums">{row.day}</td>
                  <td className="px-4 py-2.5">{eventTypeLabel(row.event_type)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.event_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </div>
  );
}
