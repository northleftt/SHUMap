import { Bus, Globe, Map, UserRound, type LucideIcon } from "lucide-react";

export interface NavTab {
  to: string;
  label: string;
  Icon: LucideIcon;
}

/** 全局四个主 Tab（移动端底栏 / 桌面端左栏共用）。 */
export const NAV_TABS: NavTab[] = [
  { to: "/map", label: "地图", Icon: Map },
  { to: "/shuttle", label: "校车", Icon: Bus },
  { to: "/offcampus", label: "校外", Icon: Globe },
  { to: "/profile", label: "我的", Icon: UserRound },
];
