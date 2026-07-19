import { NavLink } from "react-router-dom";
import { NAV_TABS } from "./navTabs";

/** 桌面/平板左侧图标栏（≥768px）：SHU logo + 主导航 + 底部「我的」。 */
export function DesktopRail() {
  const mainTabs = NAV_TABS.filter((tab) => tab.to !== "/profile");
  const profileTab = NAV_TABS[NAV_TABS.length - 1];
  return (
    <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-line bg-surface py-4">
      <NavLink to="/map" className="mb-6 grid h-11 w-11 place-items-center rounded-2xl bg-primary text-[15px] font-bold text-white no-underline">
        SHU
      </NavLink>
      <nav className="flex flex-1 flex-col items-center gap-2">
        {mainTabs.map((tab) => (
          <RailItem key={tab.to} to={tab.to} label={tab.label} Icon={tab.Icon} />
        ))}
      </nav>
      <RailItem to={profileTab.to} label={profileTab.label} Icon={profileTab.Icon} />
    </aside>
  );
}

function RailItem({ to, label, Icon }: { to: string; label: string; Icon: (typeof NAV_TABS)[number]["Icon"] }) {
  return (
    <NavLink to={to} className="flex w-14 flex-col items-center gap-1 rounded-xl py-2 no-underline">
      {({ isActive }) => (
        <span className={`flex flex-col items-center gap-1 rounded-xl px-2 py-1 ${isActive ? "text-primary" : "text-sub"}`}>
          <Icon size={22} />
          <span className="text-label">{label}</span>
        </span>
      )}
    </NavLink>
  );
}
