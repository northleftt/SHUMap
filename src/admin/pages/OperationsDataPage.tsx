import { useState } from "react";
import { Chip } from "../components/primitives";
import { AnalyticsPage } from "./AnalyticsPage";
import { FeatureFeedbackPage } from "./FeatureFeedbackPage";

// ---------------------------------------------------------------------------
// 运营数据：纯运营读数汇总页（无审核/发布动作，read:admin 即可看）。
// tab 组同 TransitPage 的做法：Chip 行 + 条件渲染面板。
// ---------------------------------------------------------------------------

const TABS = [
  { key: "analytics", label: "埋点统计" },
  { key: "feedback", label: "功能评分" },
] as const;

type Tab = (typeof TABS)[number]["key"];

export function OperationsDataPage() {
  const [tab, setTab] = useState<Tab>("analytics");
  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        {TABS.map((item) => (
          <Chip key={item.key} active={tab === item.key} onClick={() => setTab(item.key)}>
            {item.label}
          </Chip>
        ))}
      </div>
      {tab === "analytics" ? <AnalyticsPage /> : <FeatureFeedbackPage />}
    </div>
  );
}
