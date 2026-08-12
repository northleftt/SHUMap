// 地理坐标 ↔ SVG viewBox 坐标变换。
// 背景：校园底图描自 OpenStreetMap（WGS84 无偏移），楼栋控制点
// （data/campus-buildings.picked.json）全部为 gcj02。拟合出的仿射变换
// 直接吸收 gcj02 偏移与描图变形：gcj02(lng,lat) → viewBox(x,y)。
// 约定：库内所有地理坐标一律 gcj02；网页端 geolocation 拿到的是 wgs84，
// 需先经 wgs84ToGcj02 转换再进仿射。

/** @typedef {{ a:number, b:number, c:number, d:number, e:number, f:number }} GeoTransform */
// x = a*lng + b*lat + c
// y = d*lng + e*lat + f

/** @typedef {{ longitude:number, latitude:number, x:number, y:number }} GeoControlPoint */

/**
 * 最小二乘拟合 6 参数仿射变换（正规方程，每轴一个 3x3）。
 * @param {GeoControlPoint[]} points 至少 3 个控制点
 * @returns {GeoTransform}
 */
export function fitGeoTransform(points) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error("fitGeoTransform requires at least 3 control points");
  }
  // 先对经纬度与 viewBox 坐标做中心化再解正规方程：
  // 原始值（经度~121、平移量~1e7）直接平方会严重损失精度。
  let ml = 0, mt = 0, mx = 0, my = 0;
  for (const p of points) {
    ml += p.longitude; mt += p.latitude; mx += p.x; my += p.y;
  }
  const n0 = points.length;
  ml /= n0; mt /= n0; mx /= n0; my /= n0;
  // 正规方程 M * [a,b,c]^T = v，M 对两个轴相同（中心化后 c = 0）。
  let sll = 0, sla = 0, saa = 0;
  let slx = 0, sax = 0, sly = 0, say = 0;
  for (const p of points) {
    const l = p.longitude - ml, t = p.latitude - mt;
    const x = p.x - mx, y = p.y - my;
    sll += l * l; sla += l * t; saa += t * t;
    slx += l * x; sax += t * x;
    sly += l * y; say += t * y;
  }
  const a = sll * saa - sla * sla;
  if (Math.abs(a) < 1e-20) throw new Error("fitGeoTransform control points are degenerate");
  const fittedA = (slx * saa - sax * sla) / a;
  const fittedB = (sax * sll - slx * sla) / a;
  const fittedD = (sly * saa - say * sla) / a;
  const fittedE = (say * sll - sly * sla) / a;
  return {
    a: fittedA,
    b: fittedB,
    c: mx - fittedA * ml - fittedB * mt,
    d: fittedD,
    e: fittedE,
    f: my - fittedD * ml - fittedE * mt,
  };
}

/**
 * gcj02(lng,lat) → viewBox(x,y)。
 * @param {GeoTransform} t
 */
export function applyGeoTransform(t, longitude, latitude) {
  return {
    x: t.a * longitude + t.b * latitude + t.c,
    y: t.d * longitude + t.e * latitude + t.f,
  };
}

/**
 * 求逆变换：viewBox(x,y) → gcj02(lng,lat)（地图点选标注用）。
 * @param {GeoTransform} t
 * @returns {GeoTransform}
 */
export function invertGeoTransform(t) {
  const det = t.a * t.e - t.b * t.d;
  if (Math.abs(det) < 1e-12) throw new Error("GeoTransform is not invertible");
  return {
    a: t.e / det,
    b: -t.b / det,
    c: (t.b * t.f - t.e * t.c) / det,
    d: -t.d / det,
    e: t.a / det,
    f: (t.d * t.c - t.a * t.f) / det,
  };
}

/**
 * viewBox 点 → gcj02 经纬度（管理端画布选点回填导航坐标用）。
 * 结果保留 7 位小数：画布坐标本身只精确到 0.1 个 viewBox 单位（约亚米级），
 * 更多位数是噪声；7 位约 1 厘米，远小于仿射拟合残差。
 * @param {GeoTransform} t 该校区 gcj02 → viewBox 的正变换
 */
export function viewBoxToGcj02(t, x, y) {
  const inverse = invertGeoTransform(t);
  const point = applyGeoTransform(inverse, x, y);
  const round7 = (value) => Math.round(value * 1e7) / 1e7;
  return { longitude: round7(point.x), latitude: round7(point.y) };
}

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

export function outOfChina(longitude, latitude) {
  return (
    longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271
  );
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/** wgs84 → gcj02（公开逆向算法，残差约 1–2 米）。 */
export function wgs84ToGcj02(longitude, latitude) {
  if (outOfChina(longitude, latitude)) return { longitude, latitude };
  let dLat = transformLat(longitude - 105.0, latitude - 35.0);
  let dLng = transformLng(longitude - 105.0, latitude - 35.0);
  const radLat = (latitude / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { longitude: longitude + dLng, latitude: latitude + dLat };
}

/** gcj02 → wgs84（一次迭代近似，残差约 1–2 米，导出场景用）。 */
export function gcj02ToWgs84(longitude, latitude) {
  if (outOfChina(longitude, latitude)) return { longitude, latitude };
  const gcj = wgs84ToGcj02(longitude, latitude);
  return {
    longitude: longitude * 2 - gcj.longitude,
    latitude: latitude * 2 - gcj.latitude,
  };
}
