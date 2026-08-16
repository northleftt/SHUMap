export declare const TENCENT_LOCPICKER_ORIGIN: string;
export declare const TENCENT_MESSAGE_ORIGINS: readonly string[];

export declare function isTencentOrigin(origin: unknown): boolean;

export declare function locpickerUrl(options: {
  key: string;
  referer?: string;
  longitude: number;
  latitude: number;
  zoom?: number;
}): string;

export interface LocpickerPick {
  longitude: number;
  latitude: number;
  name: string;
  address: string;
  city: string;
}

export declare function readLocationPickerMessage(data: unknown): LocpickerPick | null;

export declare function isCenterEcho(
  pick: LocpickerPick | null,
  center: { longitude: number; latitude: number },
): boolean;
