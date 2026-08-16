// 腾讯位置服务「选点组件」（locpicker）的 URL 拼装与 postMessage 解析。
//
// 单独成模块而不是写在 GeoCalibrator 里，是因为这里有两个只能靠实测确认、
// 且写错了不报错、只表现为「永远收不到选点」的细节，需要被测试钉住：
//
//  1) 回传消息的 origin 不是 iframe 自己的域。locpicker 页面挂在
//     apis.map.qq.com，但真正 postMessage 回来的是它内部加载的地图组件，
//     origin 为 mapapi.qq.com。只校验 iframe 的域会把每一条选点消息都丢掉
//     （表现：地图能正常显示、POI 列表能出，但「还没有选点」永不消失）。
//     已在真实浏览器里抓过实际 origin 确认。
//  2) coord 参数是纬度在前、经度在后，和 GeoJSON 相反。写反了地图会开到
//     别的地方，同样不会报错。
//
// 回传坐标是 GCJ-02（coordtype=5 即腾讯/Google/高德坐标系），与
// shared/revision-contract.ts 的 NAVIGATION_CRS 一致，可直接入库。

/** locpicker 页面所在域，用来拼 iframe 的 src。 */
export const TENCENT_LOCPICKER_ORIGIN = "https://apis.map.qq.com";

/**
 * 允许接收 postMessage 的来源白名单。
 * mapapi.qq.com 是实际发消息的那一个（见文件头注释）；apis.map.qq.com 一并保留，
 * 以防组件日后改回从页面自身发。逐字比对完整 origin，不做后缀匹配——
 * endsWith(".qq.com") 之类会把任意子域都放进来。
 */
export const TENCENT_MESSAGE_ORIGINS = Object.freeze([
  "https://mapapi.qq.com",
  TENCENT_LOCPICKER_ORIGIN,
]);

/** @param {unknown} origin */
export function isTencentOrigin(origin) {
  return typeof origin === "string" && TENCENT_MESSAGE_ORIGINS.includes(origin);
}

/**
 * 拼选点器 iframe 的 src。
 * @param {{ key:string, referer?:string, longitude:number, latitude:number, zoom?:number }} options
 */
export function locpickerUrl({ key, referer = "SHUMap", longitude, latitude, zoom = 17 }) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error("locpickerUrl requires finite longitude and latitude");
  }
  const params = new URLSearchParams({
    search: "1",
    // type=1 才是 iframe 嵌入模式；type=0 是整页跳转，需要 backurl。
    type: "1",
    key,
    referer,
    // 纬度在前、经度在后。
    coord: `${latitude},${longitude}`,
    // 5 = 腾讯/Google/高德坐标系（GCJ-02）。
    coordtype: "5",
    zoom: String(zoom),
  });
  return `${TENCENT_LOCPICKER_ORIGIN}/tools/locpicker?${params.toString()}`;
}

/** @typedef {{ longitude:number, latitude:number, name:string, address:string, city:string }} LocpickerPick */

/**
 * 判断一条解析出来的选点是不是「载入回显」。
 *
 * 选点器载入完成时会把 URL 里的 coord（也就是我们指定的地图中心）原样
 * postMessage 回来一次，payload 形状与真实选点**完全相同**，无法从内容上区分。
 * 把它当成选点会凭空多出一个控制点：经纬度是校区中心常量、底图坐标是用户在
 * 右边随手点的第一个位置，两者毫无关系，残差可达数百米，并且因为最小二乘会
 * 迁就它，整套参数都被拖偏。
 *
 * 判据用严格全等：真实点击落在地图上，经纬度是连续量，7 位小数恰好与常量中心
 * 逐位相同的概率可以忽略；反过来回显必然逐位相同。因此不用容差——用容差会把
 * 中心附近的真实点击也误杀。
 *
 * @param {LocpickerPick} pick
 * @param {{ longitude:number, latitude:number }} center 传给 locpickerUrl 的中心
 */
export function isCenterEcho(pick, center) {
  if (!pick || !center) return false;
  return pick.longitude === center.longitude && pick.latitude === center.latitude;
}

/**
 * 解析一条 postMessage 的 data。不是选点消息就返回 null。
 *
 * data 可能是对象也可能是 JSON 字符串——同一页上还会混入地图组件自己的其他
 * 消息，所以两种都得接、且必须靠 module 字段判别而不是"有 latlng 就算"。
 *
 * @param {unknown} data
 * @returns {LocpickerPick | null}
 */
export function readLocationPickerMessage(data) {
  let payload = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.module !== "locationPicker") return null;
  const latlng = payload.latlng;
  if (!latlng || typeof latlng !== "object") return null;
  const latitude = latlng.lat;
  const longitude = latlng.lng;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    longitude,
    latitude,
    name: text(payload.poiname),
    address: text(payload.poiaddress),
    city: text(payload.cityname),
  };
}
