import {
  ArrowUpDown,
  BatteryCharging,
  Bike,
  BookOpen,
  Bus,
  CircleParking,
  Dumbbell,
  GlassWater,
  HeartPulse,
  Info,
  Landmark,
  Mail,
  MapPin,
  Package,
  PlugZap,
  Printer,
  ShieldCheck,
  ShoppingBasket,
  Sofa,
  Toilet,
  Trash2,
  Utensils,
  Wifi,
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

/**
 * facility_types.icon_key → Lucide 图标。这是后台「设施类型」维护界面可选的图标全集，
 * 与 worker/modules/facility-types.ts 的 SUPPORTED_ICON_KEYS 一一对应（那边是校验用的
 * 权威列表，接口会把它回给界面，这里只负责把 key 渲染成图标与中文名）。
 */
export const FACILITY_ICON_BY_KEY: Record<string, LucideIcon> = {
  printer: Printer,
  desk: BookOpen,
  restroom: Toilet,
  water: GlassWater,
  elevator: ArrowUpDown,
  vending: ShoppingBasket,
  battery: BatteryCharging,
  charging: PlugZap,
  service: Info,
  wifi: Wifi,
  food: Utensils,
  parking: CircleParking,
  bike: Bike,
  bus: Bus,
  mail: Mail,
  health: HeartPulse,
  lounge: Sofa,
  locker: Package,
  security: ShieldCheck,
  landmark: Landmark,
  sports: Dumbbell,
  trash: Trash2,
  generic: MapPin,
};

/** 图标的中文说明，后台下拉里与图标预览一起显示。 */
export const FACILITY_ICON_KEY_LABELS: Record<string, string> = {
  printer: "打印机",
  desk: "书桌 / 自习",
  restroom: "卫生间",
  water: "饮水",
  elevator: "电梯",
  vending: "售货",
  battery: "充电宝",
  charging: "充电桩",
  service: "服务咨询",
  wifi: "网络",
  food: "餐饮",
  parking: "停车",
  bike: "自行车",
  bus: "班车",
  mail: "邮件快递",
  health: "医疗",
  lounge: "休息区",
  locker: "储物柜",
  security: "安保",
  landmark: "地标",
  sports: "运动",
  trash: "垃圾投放",
  generic: "通用标记",
};

/** icon_key → 图标组件；未知或留空时用通用标记兜底。 */
export function facilityIconByKey(iconKey: string | null | undefined): LucideIcon {
  return (iconKey ? FACILITY_ICON_BY_KEY[iconKey] : undefined) ?? MapPin;
}

export function facilityIconKeyLabel(iconKey: string): string {
  return FACILITY_ICON_KEY_LABELS[iconKey] ?? "通用标记";
}

/**
 * 类型编码 → 图标。九个内置类型有各自的图标；后台新增的类型编码不在表里，
 * 退一步按 icon_key 同名匹配，都没有就用通用标记。
 */
export function facilityIcon(typeCode: string): LucideIcon {
  return FACILITY_ICONS[typeCode] ?? FACILITY_ICON_BY_KEY[typeCode] ?? MapPin;
}

/** M4 设施行左侧色点（按类别轮换，对应设计稿多色圆点）。 */
export const FACILITY_DOT_COLORS = ["#f59e0b", "#1e80c1", "#16a34a", "#94a3b8"];

export function facilityDotColor(index: number): string {
  return FACILITY_DOT_COLORS[index % FACILITY_DOT_COLORS.length];
}
