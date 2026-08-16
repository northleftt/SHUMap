import type { GeoTransform } from "./geo-transform.d.mts";

export interface CampusGeoTransformRecord {
  mapVersionId: string;
  viewBox: { width: number; height: number };
  controlPoints: number;
  meanResidualMeters: number;
  transformUncertaintyMeters: { median: number; p90: number };
  transform: GeoTransform;
}

export declare const CAMPUS_GEO_TRANSFORM_RECORDS: Readonly<
  Record<"baoshan" | "jiading" | "yanchang", CampusGeoTransformRecord>
>;

export declare function geoTransformRecordOf(
  campusCode: unknown,
): CampusGeoTransformRecord | null;
