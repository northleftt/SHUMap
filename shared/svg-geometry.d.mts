export interface SvgViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedSvgFeature {
  order: number;
  sourceElementId: string;
  stableKey: string | null;
  geometry: Record<string, unknown> | null;
  bbox: [number, number, number, number] | null;
  approximated: boolean;
  label: string | null;
}

export function parseSvgViewBox(svg: string): SvgViewBox;
export function parseSvgFeatures(svg: string): ParsedSvgFeature[];
