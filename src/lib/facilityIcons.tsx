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

/**
 * facility_types.icon_key → Lucide 图标。这是后台「设施类型」维护界面可选的内置图标全集，
 * 与 worker/modules/facility-types.ts 的 SUPPORTED_ICON_KEYS 一一对应（那边是校验用的
 * 权威列表，接口会把它回给界面，这里只负责把 key 渲染成图标与中文名）。
 *
 * 后台还能上传自定义图标（0029，键带 `custom-` 前缀），那些不在这张表里 ——
 * 走 facilityIconUrl 从服务端取 SVG，见本文件下半部分。
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

/** 图标的中文说明，后台图标选择器里与图标预览一起显示。 */
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

/**
 * 出厂九类的**类型编码** → icon_key。
 *
 * 为什么需要这张表：编码与图标键是故意不同名的（`drinking_water` 的图标键叫
 * `water`、`vending_machine` 叫 `vending`、`service_center` 叫 `service`），所以
 * 「拿编码去撞图标键」对这九类不成立，只能手写映射。
 *
 * 这张表**只是回落**。管理员在后台给类型选的 icon_key 才是权威来源，见
 * resolveFacilityIconKey —— 那里优先读发布数据里的 iconKey，读不到才落到这里。
 */
export const FACILITY_TYPE_CODE_ICON_KEYS: Record<string, string> = {
  printer: "printer",
  study_area: "desk",
  restroom: "restroom",
  drinking_water: "water",
  elevator: "elevator",
  vending_machine: "vending",
  power_bank: "battery",
  charging_station: "charging",
  service_center: "service",
};

/** icon_key → 内置图标组件；未知或留空时用通用标记兜底。 */
export function facilityIconByKey(iconKey: string | null | undefined): LucideIcon {
  return (iconKey ? FACILITY_ICON_BY_KEY[iconKey] : undefined) ?? MapPin;
}

export function facilityIconKeyLabel(iconKey: string): string {
  return FACILITY_ICON_KEY_LABELS[iconKey] ?? "通用标记";
}

// ---------------------------------------------------------------------------
// 自定义图标（0029）：后台上传的 SVG，按 icon_key 从服务端取
// ---------------------------------------------------------------------------

/** 自定义图标键的前缀。与 worker/modules/facility-icons.ts 的 isCustomIconKey 同一判定。 */
const CUSTOM_ICON_PREFIX = "custom-";

export function isCustomIconKey(iconKey: string | null | undefined): boolean {
  return typeof iconKey === "string" && iconKey.startsWith(CUSTOM_ICON_PREFIX);
}

/**
 * 图钉的两个态。自定义图标是独立文档（<img>/<image> 引用），继承不到外面的
 * color，所以颜色由服务端按 ink 替换 currentColor 后输出 —— 这两个值必须与
 * worker/modules/facility-icons.ts 的 INKS 键一致。
 */
export type IconInk = "primary" | "white";

export function facilityIconUrl(iconKey: string, ink: IconInk = "primary"): string {
  return `/api/public/facility-icons/${encodeURIComponent(iconKey)}?ink=${ink}`;
}

/**
 * 类型编码 → icon_key，**以管理员在后台的选择为准**。
 *
 * `iconKeyByTypeCode` 从发布数据的 facilityTypes 建（见 facilityIconKeyMap）。传 null
 * 表示调用方手上没有那份数据，此时只能靠回落表 —— 但那意味着后台新建的类型会掉到
 * 通用图钉，所以能拿到发布数据的地方都应该传进来。
 *
 * 回落顺序：出厂九类的编码映射 → 编码恰好与某个内置图标键同名 → null（通用标记）。
 */
export function resolveFacilityIconKey(
  typeCode: string,
  iconKeyByTypeCode: ReadonlyMap<string, string | null> | null,
): string | null {
  const chosen = iconKeyByTypeCode?.get(typeCode);
  if (chosen) return chosen;
  const legacy = FACILITY_TYPE_CODE_ICON_KEYS[typeCode];
  if (legacy) return legacy;
  return FACILITY_ICON_BY_KEY[typeCode] ? typeCode : null;
}

/** 发布数据的 facilityTypes → 编码查表，喂给 resolveFacilityIconKey。 */
export function facilityIconKeyMap(
  facilityTypes: readonly { code: string; iconKey: string | null }[],
): Map<string, string | null> {
  return new Map(facilityTypes.map((type) => [type.code, type.iconKey]));
}

/*
 * 这里曾有一个 facilityIcon(typeCode)：只吃「类型编码」，拿它去撞图标键。
 * 它是那个缺口的载体 —— POI 详情 / 楼层图 / 平面图钉 / 采集表单四处用它，于是
 * 管理员在后台选的 icon_key 在这四处完全不生效（只有出厂九类靠手写映射能对上）。
 *
 * 删掉而不是留着加注释警告：它的签名里根本没有 iconKey 的位置，任何新调用点用上
 * 它都会再次复现同一个 bug。要图标就用 <FacilityGlyph iconKey=…>，拿不到 iconKey
 * 时先用 facilityIconKeyMap 从发布数据（或 GET /api/public/facility-types）里查。
 */

/**
 * 一枚设施图标（HTML 上下文）。内置键渲染 lucide 组件，自定义键渲染 <img>。
 *
 * 自定义图标用 <img> 而不是内联 SVG：内联要先 fetch 再注入，等于自己实现一套
 * 缓存；<img> 走浏览器的 HTTP 缓存，而服务端已经配好 ETag + must-revalidate。
 */
export function FacilityGlyph({
  iconKey,
  size = 18,
  ink = "primary",
  className,
}: {
  iconKey: string | null | undefined;
  size?: number;
  /** 自定义图标的取色档；内置图标由 CSS 的 currentColor 决定，与这个参数无关。 */
  ink?: IconInk;
  className?: string;
}) {
  if (isCustomIconKey(iconKey)) {
    return (
      <img
        alt=""
        aria-hidden
        className={className}
        height={size}
        src={facilityIconUrl(iconKey as string, ink)}
        width={size}
      />
    );
  }
  const Icon = facilityIconByKey(iconKey);
  return <Icon className={className} size={size} />;
}

/**
 * 一枚设施图标（SVG 子元素上下文，如地图图钉层）。
 *
 * 与 FacilityGlyph 分成两个组件而不是一个：SVG 里放 <img> 是无效的，得用
 * <image>；而 lucide 组件在 SVG 里要靠 x/y 定位、靠 color 上色，签名与 HTML
 * 上下文那份对不上。硬塞进一个组件会得到一堆互斥的可选参数。
 */
export function FacilityGlyphSvg({
  iconKey,
  x,
  y,
  size,
  color,
  ink,
  strokeWidth = 2.2,
}: {
  iconKey: string | null | undefined;
  /** 图标中心点（世界坐标）。 */
  x: number;
  y: number;
  size: number;
  /** 内置图标的描边色。 */
  color: string;
  /** 自定义图标的取色档。 */
  ink: IconInk;
  strokeWidth?: number;
}) {
  const left = x - size / 2;
  const top = y - size / 2;
  if (isCustomIconKey(iconKey)) {
    return (
      <image
        height={size}
        href={facilityIconUrl(iconKey as string, ink)}
        pointerEvents="none"
        preserveAspectRatio="xMidYMid meet"
        width={size}
        x={left}
        y={top}
      />
    );
  }
  const Icon = facilityIconByKey(iconKey);
  return (
    <Icon
      color={color}
      height={size}
      pointerEvents="none"
      strokeWidth={strokeWidth}
      width={size}
      x={left}
      y={top}
    />
  );
}

/** M4 设施行左侧色点（按类别轮换，对应设计稿多色圆点）。 */
export const FACILITY_DOT_COLORS = ["#f59e0b", "#1e80c1", "#16a34a", "#94a3b8"];

export function facilityDotColor(index: number): string {
  return FACILITY_DOT_COLORS[index % FACILITY_DOT_COLORS.length];
}
