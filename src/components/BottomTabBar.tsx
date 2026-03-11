import { NavLink } from "react-router-dom";

const tabs = [
  { to: "/map", label: "地图" },
  { to: "/shuttle", label: "校车" },
  { to: "/offcampus", label: "校外" },
  { to: "/profile", label: "我的" },
];

function TabIcon({ active }: { active: boolean }) {
  return (
    <span
      className="grid size-6 place-items-center rounded-full border transition-colors"
      style={{
        borderColor: active ? "var(--color-primary)" : "rgba(111,124,142,0.6)",
        background: active ? "rgba(215,232,243,0.95)" : "transparent",
      }}
    >
      <span
        className="block size-2 rounded-full"
        style={{ background: active ? "var(--color-primary)" : "rgba(111,124,142,0.6)" }}
      />
    </span>
  );
}

export function BottomTabBar({ height }: { height: number }) {
  return (
    <nav
      className="safe-bottom-padding absolute inset-x-0 bottom-0 z-40 border-t border-[rgba(203,213,225,0.95)] bg-white/96 backdrop-blur-xl"
      style={{ height }}
    >
      <div className="grid h-full grid-cols-4 items-center px-4">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className="flex h-full flex-col items-center justify-center gap-1 no-underline"
          >
            {({ isActive }) => (
              <>
                <TabIcon active={isActive} />
                <span
                  className="text-[11px] font-medium tracking-[0.02em]"
                  style={{
                    color: isActive ? "var(--color-primary)" : "var(--color-text-muted)",
                  }}
                >
                  {tab.label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
