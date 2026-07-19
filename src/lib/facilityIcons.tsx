import {
  ArrowUpDown,
  BatteryCharging,
  BookOpen,
  GlassWater,
  Info,
  MapPin,
  PlugZap,
  Printer,
  ShoppingBasket,
  Toilet,
  type LucideIcon,
} from "lucide-react";

/** facility_types.code → Lucide 图标（M2 设施指引 / M4 楼层设施共用）。 */
export const FACILITY_ICONS: Record<string, LucideIcon> = {
  printer: Printer,
  study_area: BookOpen,
  restroom: Toilet,
  drinking_water: GlassWater,
  elevator: ArrowUpDown,
  vending_machine: ShoppingBasket,
  power_bank: BatteryCharging,
  charging_station: PlugZap,
  service_center: Info,
};

export function facilityIcon(typeCode: string): LucideIcon {
  return FACILITY_ICONS[typeCode] ?? MapPin;
}

/** M4 设施行左侧色点（按类别轮换，对应设计稿多色圆点）。 */
export const FACILITY_DOT_COLORS = ["#f59e0b", "#1e80c1", "#16a34a", "#94a3b8"];

export function facilityDotColor(index: number): string {
  return FACILITY_DOT_COLORS[index % FACILITY_DOT_COLORS.length];
}
