export interface GeoTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface GeoControlPoint {
  longitude: number;
  latitude: number;
  x: number;
  y: number;
}

export function fitGeoTransform(points: GeoControlPoint[]): GeoTransform;
export function applyGeoTransform(
  t: GeoTransform,
  longitude: number,
  latitude: number,
): { x: number; y: number };
export function invertGeoTransform(t: GeoTransform): GeoTransform;
export function viewBoxToGcj02(
  t: GeoTransform,
  x: number,
  y: number,
): { longitude: number; latitude: number };
export function metersPerViewBoxUnit(
  t: GeoTransform,
  latitude?: number,
): { x: number; y: number };
export function geoTransformResiduals(
  t: GeoTransform,
  points: GeoControlPoint[],
  latitude?: number,
): Array<{ dx: number; dy: number; meters: number }>;
export function outOfChina(longitude: number, latitude: number): boolean;
export function wgs84ToGcj02(
  longitude: number,
  latitude: number,
): { longitude: number; latitude: number };
export function gcj02ToWgs84(
  longitude: number,
  latitude: number,
): { longitude: number; latitude: number };
