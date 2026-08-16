// 各校区 gcj02 ↔ viewBox 仿射参数的**完整**记录（含底图版本）。
//
// 与 src/lib/release/mapData.ts 的 CAMPUS_GEO_TRANSFORMS 的区别：那份只有 6 个系数，
// 够渲染用；这份额外带 mapVersionId 与 viewBox，因为「参数是在哪张底图上拟合的」本身
// 就是安全属性 —— 同一校区库里存在两套 map_features（仓库图 map_version_campus_* 与
// 发版图 mapver_*），坐标空间相差约 65 个 viewBox 单位≈107m，拿错了算出来的经纬度
// 会整体偏移、且处处自洽看不出来（这个坑真踩过）。自动推导导航终点必须能校验这一点。
//
// 数值来自 data/geo-transform.json（由 scripts/generate_geo_transform.mjs 生成）；
// tests/geo-transform-params-in-sync.test.mjs 钉住两者一致。

/** @typedef {{ a:number,b:number,c:number,d:number,e:number,f:number }} GeoTransform */

export const CAMPUS_GEO_TRANSFORM_RECORDS = Object.freeze({
  baoshan: Object.freeze({
    mapVersionId: "mapver_4ba7a816ef2f46f2be71a0845330eee6",
    viewBox: Object.freeze({ width: 921.6, height: 1019.7 }),
    controlPoints: 14,
    meanResidualMeters: 3.03,
    transformUncertaintyMeters: Object.freeze({ median: 1.39, p90: 2.93 }),
    transform: Object.freeze({ a: 57870.544765, b: -500.500912, c: -7008973.362112, d: 298.426944, e: -68036.383694, f: 2094863.561335 }),
  }),
  jiading: Object.freeze({
    mapVersionId: "mapver_f2819d3660e2439fa52522a7eb75861e",
    viewBox: Object.freeze({ width: 466, height: 362 }),
    controlPoints: 9,
    meanResidualMeters: 4.88,
    transformUncertaintyMeters: Object.freeze({ median: 3.16, p90: 7.86 }),
    transform: Object.freeze({ a: 36184.114252, b: 26650.692067, c: -5223290.47875, d: 21126.051518, e: -42297.949781, f: -1234168.403812 }),
  }),
  yanchang: Object.freeze({
    mapVersionId: "mapver_7e0a74d115d8470b8fd395750e0dd4d3",
    viewBox: Object.freeze({ width: 1430, height: 1316 }),
    controlPoints: 9,
    meanResidualMeters: 4.72,
    transformUncertaintyMeters: Object.freeze({ median: 2.8, p90: 8.23 }),
    transform: Object.freeze({ a: 137462.094483, b: 46048.388754, c: -18135449.011918, d: 41441.499919, e: -162736.490688, f: 57019.439156 }),
  }),
});

/** campuses.code → 记录。未知校区返回 null（调用方据此跳过而不是猜一个）。 */
export function geoTransformRecordOf(campusCode) {
  if (typeof campusCode !== "string") return null;
  return CAMPUS_GEO_TRANSFORM_RECORDS[campusCode] ?? null;
}
