import { Compass } from "lucide-react";
import { useState } from "react";
import { GeoCalibrator } from "../components/GeoCalibrator";

// ---------------------------------------------------------------------------
// 开发工具：一次性 / 低频的调试与标定工具的落脚处。
//
// 这些工具不属于日常运营流程（不该混在内容管理里），但也不值得各自建一个侧栏入口
// 用完就删。放在这里按 tab 并列，以后加新工具只需往 TOOLS 里加一项。
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    key: "geo-calibrator",
    label: "坐标校准器",
    icon: Compass,
    description: "标定各校区 GCJ-02 ↔ 底图 viewBox 的仿射变换控制点",
    render: () => <GeoCalibrator />,
  },
] as const;

export function DevToolsPage() {
  const [active, setActive] = useState<(typeof TOOLS)[number]["key"]>(TOOLS[0].key);
  const tool = TOOLS.find((item) => item.key === active) ?? TOOLS[0];

  return (
    <div className="space-y-4">
      {TOOLS.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {TOOLS.map((item) => (
            <button
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-body font-medium ${
                item.key === active
                  ? "border-primary bg-primary text-white"
                  : "border-line bg-surface text-ink hover:bg-page"
              }`}
              key={item.key}
              onClick={() => setActive(item.key)}
              type="button"
            >
              <item.icon size={14} />
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-aux text-sub">{tool.description}</p>
      {tool.render()}
    </div>
  );
}
