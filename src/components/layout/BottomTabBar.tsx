import { NavLink } from "react-router-dom";
import { NAV_TABS } from "./navTabs";

export const TAB_BAR_HEIGHT = 64;

/** 移动端底部 Tab 栏（<768px）。 */
export function BottomTabBar() {
  return (
    <nav
      data-bottom-tab-bar
      className="safe-bottom-padding absolute inset-x-0 bottom-0 z-40 border-t border-line bg-surface/96 backdrop-blur-xl"
      style={{ height: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))` }}
    >
      <div className="grid h-16 grid-cols-4 items-center px-2">
        {NAV_TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className="flex h-full flex-col items-center justify-center gap-1 no-underline">
            {({ isActive }) => (
              <>
                <tab.Icon size={22} className={isActive ? "text-primary" : "text-sub"} />
                <span className={`text-label ${isActive ? "text-primary" : "text-sub"}`}>{tab.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
