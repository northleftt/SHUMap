import type { CampusGeoTransformRecord } from "./campus-geo-records.d.mts";

export interface RepresentativePoint {
  point: [number, number];
  method: string;
}

export declare function representativePoint(geometry: unknown): RepresentativePoint | null;

export interface DerivedNavigationTarget {
  longitude: number;
  latitude: number;
  method: string;
  accuracyMeters: number | null;
}

export declare function deriveNavigationTarget(options: {
  geometry: unknown;
  mapVersionId?: string | null;
  params: Pick<CampusGeoTransformRecord, "transform"> &
    Partial<Pick<CampusGeoTransformRecord, "mapVersionId" | "transformUncertaintyMeters">>;
}): DerivedNavigationTarget | null;
