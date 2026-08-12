import type { GeoTransform } from "./geo-transform.mjs";

export declare const METERS_PER_DEGREE_LNG: number;

export declare function wgs84ToViewBoxPoint(
  transform: GeoTransform,
  longitude: number,
  latitude: number,
): { x: number; y: number };

export declare function metersToViewBoxUnits(transform: GeoTransform, meters: number): number;

export declare function isPointInViewBox(
  point: { x: number; y: number },
  viewBox: { x: number; y: number; width: number; height: number },
): boolean;

export interface CampusGeoEntry {
  key: string;
  geoTransform: GeoTransform;
  viewBox: { x: number; y: number; width: number; height: number };
}

export declare function campusKeyForGcj02Point(
  campuses: CampusGeoEntry[],
  longitude: number,
  latitude: number,
): string | null;
