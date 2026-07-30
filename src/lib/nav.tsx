/**
 * 外部地图 App 调起。
 *
 * 本项目的地图坐标系是 SVG viewbox，业务库里并没有逐楼的经纬度可以直接拿来导航，
 * 所以外部地图只有两种可用的定位方式：
 *
 * 1. 校区级：用下面这份硬编码的经纬度常量落一个标记点（marker）。
 * 2. 楼栋级：用「校区名 + 地点名」做关键字搜索（search），由地图自己解析 POI。
 *
 * 两种方式都不依赖 release 数据里的坐标，任何地点都能导航。
 *
 * 交互上这里走「让用户选地图」而不是 UA 猜测 + scheme 超时兜底，理由见 mapProviderOptions。
 */

import { useEffect } from "react";
import type { CampusKey } from "./types";

// ---------------------------------------------------------------------------
// 校区经纬度常量
// ---------------------------------------------------------------------------

/**
 * 三校区锚点坐标。
 *
 * 坐标系：**GCJ-02**（高德/腾讯口径）。高德、百度（传 coord_type=gcj02）都按此系解读。
 *
 * 数据来源：本仓库 `data/campus-buildings.picked.json` —— 121 个楼栋点位全部由
 * openGPS 高德坐标拾取器人工拾取并标记 verified（`coordSystem: "gcj02"`）。
 * 这里的校区锚点取各校区已拾取楼栋的外包框中心，精度是校区级/主入口级，
 * 足够让地图定位到正确校区；真正的门牌级精度交给 keywords 让地图自己解析。
 *
 * 官方地址（用于关键字兜底与百度 region 参数）：
 * - 宝山：上海市宝山区上大路 99 号
 * - 延长：上海市静安区延长路 149 号
 * - 嘉定：上海市嘉定区城中路 20 号
 */
export const CAMPUS_ANCHORS: Record<CampusKey, { label: string; longitude: number; latitude: number }> = {
  baoshan: { label: "宝山校区", longitude: 121.394492, latitude: 31.316372 },
  yanchang: { label: "延长校区", longitude: 121.458184, latitude: 31.275238 },
  jiading: { label: "嘉定校区", longitude: 121.248656, latitude: 31.377023 },
};

/** 上海市 adcode，用于把关键字搜索限定在本市（高德 city / 百度 region）。 */
const CITY_ADCODE = "310000";
const CITY_NAME = "上海";
const SCHOOL = "上海大学";
const SRC_AMAP = "SHUMap";
const SRC_BAIDU = "webapp.shumap.shumap";

/** 把「宝山校区」「上海大学嘉定校区」这类名字或 CampusKey 归一到 CampusKey。 */
export function resolveCampusKey(input: string | null | undefined): CampusKey | null {
  if (!input) return null;
  const text = String(input);
  if (text === "baoshan" || text === "yanchang" || text === "jiading") return text;
  if (text.includes("宝山")) return "baoshan";
  if (text.includes("延长")) return "yanchang";
  if (text.includes("嘉定")) return "jiading";
  return null;
}

// ---------------------------------------------------------------------------
// 目标与链接构造
// ---------------------------------------------------------------------------

export interface MapTarget {
  /** CampusKey 或校区名（「宝山校区」等）。 */
  campus: CampusKey | string | null;
  /** 楼栋/点位名。给了就走关键字搜索，没给就在校区锚点落标记。 */
  placeName?: string | null;
}

export type MapProvider = "amap" | "baidu" | "apple";

interface ResolvedTarget {
  campusKey: CampusKey | null;
  campusLabel: string;
  /** 搜索关键字，如「上海大学宝山校区 A 楼」。 */
  keyword: string;
  /** 展示名，如「A 楼」或「宝山校区」。 */
  displayName: string;
  longitude: number | null;
  latitude: number | null;
  /**
   * true = 楼栋级，用关键字搜索（校区锚点坐标在楼栋级别不够准，落点会偏）；
   * false = 校区级，用校区锚点落标记点。
   */
  useKeyword: boolean;
}

function resolveTarget(target: MapTarget): ResolvedTarget {
  const campusKey = resolveCampusKey(target.campus);
  const anchor = campusKey ? CAMPUS_ANCHORS[campusKey] : null;
  const campusLabel = anchor?.label ?? (typeof target.campus === "string" ? target.campus : "");
  const placeName = target.placeName?.trim() || "";
  const keyword = [SCHOOL, campusLabel, placeName].filter(Boolean).join(" ").trim() || SCHOOL;
  return {
    campusKey,
    campusLabel,
    keyword,
    displayName: placeName || campusLabel || SCHOOL,
    longitude: anchor?.longitude ?? null,
    latitude: anchor?.latitude ?? null,
    // 有楼栋名，或压根没匹配上校区锚点，都只能靠关键字
    useKeyword: placeName !== "" || anchor === null,
  };
}

/** 能落坐标标记点（校区级目标且锚点已知）。 */
function canUseMarker(resolved: ResolvedTarget): boolean {
  return !resolved.useKeyword && resolved.longitude !== null && resolved.latitude !== null;
}

/** 目标的人类可读描述，用于按钮 aria-label 与选单标题。 */
export function mapTargetLabel(target: MapTarget): string {
  const resolved = resolveTarget(target);
  return resolved.displayName;
}

/**
 * 高德 URI API。
 *
 * - 关键字搜索：`https://uri.amap.com/search?keyword=&city=&view=map&src=&callnative=1`
 * - 位置标记：  `https://uri.amap.com/marker?position=lon,lat&name=&src=&coordinate=gaode&callnative=1`
 *
 * `callnative=1` 是关键：高德自己在落地页判断有没有装 App 并尝试调起
 * （iosamap:// / androidamap://），装了就进 App，没装就留在 H5。
 * 所以我们不需要自己写 scheme + setTimeout 竞速。
 * `coordinate=gaode` 声明传入的是 GCJ-02。
 */
function amapUrl(resolved: ResolvedTarget): string {
  if (canUseMarker(resolved)) {
    const position = `${resolved.longitude},${resolved.latitude}`;
    return `https://uri.amap.com/marker?position=${encodeURIComponent(position)}&name=${encodeURIComponent(
      resolved.displayName,
    )}&src=${encodeURIComponent(SRC_AMAP)}&coordinate=gaode&callnative=1`;
  }
  return `https://uri.amap.com/search?keyword=${encodeURIComponent(
    resolved.keyword,
  )}&city=${CITY_ADCODE}&view=map&src=${encodeURIComponent(SRC_AMAP)}&callnative=1`;
}

/**
 * 百度地图 URI API（web/H5，output=html 落地页会自己提示「打开百度地图 App」）。
 *
 * - 标记：`https://api.map.baidu.com/marker?location=lat,lng&title=&content=&output=html&coord_type=gcj02&src=`
 * - 搜索：`https://api.map.baidu.com/place/search?query=&region=&output=html&coord_type=gcj02&src=`
 *
 * 注意百度 location 是「纬度,经度」顺序（与高德相反），且必须显式带 coord_type=gcj02，
 * 否则会按默认 bd09 解读导致偏移几百米。src 格式为 `webapp.companyName.appName`。
 */
function baiduUrl(resolved: ResolvedTarget): string {
  const src = `&src=${encodeURIComponent(SRC_BAIDU)}&coord_type=gcj02&output=html`;
  if (canUseMarker(resolved)) {
    const location = `${resolved.latitude},${resolved.longitude}`;
    return `https://api.map.baidu.com/marker?location=${encodeURIComponent(location)}&title=${encodeURIComponent(
      resolved.displayName,
    )}&content=${encodeURIComponent(resolved.keyword)}${src}`;
  }
  return `https://api.map.baidu.com/place/search?query=${encodeURIComponent(
    resolved.keyword,
  )}&region=${encodeURIComponent(CITY_NAME)}${src}`;
}

/**
 * 苹果地图 Map Links：`https://maps.apple.com/?q=<关键字>`。
 * iOS/macOS 的 Safari 会自动换端到地图 App，无需 scheme。
 *
 * 这里只用 `q` 关键字、不传 `ll`：苹果地图在中国大陆的底图是 GCJ-02 偏移过的，
 * 而 `ll` 的基准并不明确，传 GCJ-02 有落点漂移的风险；交给关键字让苹果自己解析更稳。
 */
function appleUrl(resolved: ResolvedTarget): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(resolved.keyword)}`;
}

const PROVIDER_LABELS: Record<MapProvider, string> = {
  amap: "高德地图",
  baidu: "百度地图",
  apple: "苹果地图",
};

/** iOS / macOS 才提供苹果地图这一项。 */
function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent);
}

export function mapUrl(target: MapTarget, provider: MapProvider): string {
  const resolved = resolveTarget(target);
  if (provider === "baidu") return baiduUrl(resolved);
  if (provider === "apple") return appleUrl(resolved);
  return amapUrl(resolved);
}

/**
 * 可选的地图渠道。
 *
 * 为什么是「让用户选」而不是「按 UA 自动调 scheme + 超时兜底」：
 * - scheme 竞速本身不可靠：iOS Safari 对未安装的自定义 scheme 会弹系统报错框，
 *   而调起成功时页面进入后台，setTimeout 可能延迟触发导致误判并二次跳转；
 *   微信/QQ 等内置浏览器直接拦掉所有非白名单 scheme，超时兜底会稳定误伤。
 * - 三家的 https 落地页都自带调起能力（高德 callnative=1、百度 output=html 落地页、
 *   苹果 maps.apple.com 自动换端），把选择权交给它们各自的官方页最稳。
 * - 结果是每次点击只有一次确定的跳转、一条 https 链接，桌面与微信内也不会白屏。
 */
export function mapProviderOptions(target: MapTarget): Array<{ provider: MapProvider; label: string; url: string }> {
  const providers: MapProvider[] = isApplePlatform() ? ["amap", "baidu", "apple"] : ["amap", "baidu"];
  return providers.map((provider) => ({
    provider,
    label: PROVIDER_LABELS[provider],
    url: mapUrl(target, provider),
  }));
}

/** 直接调起指定地图（新标签打开官方落地页，由其决定进 App 还是留网页）。 */
export function openInMapApp(target: MapTarget, provider: MapProvider = "amap"): void {
  window.open(mapUrl(target, provider), "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// 选择地图的底部弹层
// ---------------------------------------------------------------------------

/**
 * 「用哪个地图打开」选单。层级高于 SheetModal（z-50），所以能盖在班次详情弹卡之上。
 */
export function MapAppSheet({
  target,
  onClose,
}: {
  target: MapTarget | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;
  const options = mapProviderOptions(target);

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="safe-bottom-padding absolute inset-x-0 bottom-0 rounded-t-4xl bg-surface px-5 pb-2 pt-5 shadow-sheet">
        <div className="text-center">
          <div className="text-emphasis text-ink">用地图打开</div>
          <div className="mt-1 text-aux text-sub">{mapTargetLabel(target)}</div>
        </div>
        <div className="mt-4 divide-y divide-line">
          {options.map((option) => (
            <a
              key={option.provider}
              className="block py-3.5 text-center text-body font-medium text-primary no-underline active:opacity-60"
              href={option.url}
              onClick={onClose}
              rel="noreferrer noopener"
              target="_blank"
            >
              {option.label}
            </a>
          ))}
        </div>
        <button
          type="button"
          className="mt-2 w-full rounded-full bg-page py-3 text-body font-medium text-ink active:opacity-70"
          onClick={onClose}
        >
          取消
        </button>
      </div>
    </div>
  );
}
