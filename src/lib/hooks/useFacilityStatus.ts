import { getFacilityStatus } from "../api/public";
import type { FacilityOperationalStatus, FacilityStatusResponse } from "../api/types";
import { useAsyncData } from "./useAsyncData";

/**
 * 设施运营状态的提示文案。available 与 unknown 不出文案：能用是常态，
 * 「状态未知」对用户也没有信息量，只有真的不能用才值得占一行。
 */
const FACILITY_STATUS_LABELS: Record<FacilityOperationalStatus, string | null> = {
  available: null,
  unavailable: "暂停使用",
  partially_available: "部分可用",
  unknown: null,
};

export function facilityStatusLabel(status: FacilityOperationalStatus): string | null {
  return FACILITY_STATUS_LABELS[status];
}

/**
 * 设施运营状态的实时覆盖层（GET /api/public/facility-status）。
 *
 * manifest 里的 operationalStatus 是发布快照基线，「充电桩坏了」这类改动要立刻
 * 生效，所以状态另走实时接口盖在基线上。调用方同时展示加载失败状态，避免把
 * 过期快照呈现成当前状态。
 */
export function useFacilityStatus() {
  const { state } = useAsyncData((signal) => getFacilityStatus(signal), []);
  if (state.status === "loading") return { status: "loading" } as const;
  if (state.status === "error") return { status: "error", message: state.message } as const;
  return { status: "ready", statuses: state.data.statuses } as const satisfies {
    status: "ready";
    statuses: FacilityStatusResponse["statuses"];
  };
}

export function resolveFacilityStatus(
  statuses: FacilityStatusResponse["statuses"],
  facilityId: string,
): FacilityOperationalStatus {
  const status = statuses[facilityId];
  if (status === undefined) throw new Error(`实时设施状态缺少 ${facilityId}`);
  return status;
}
