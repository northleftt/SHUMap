// 设施运营状态徽标文案（Web 端 useFacilityStatus.facilityStatusLabel 的可用子集）。
// available / unknown 不出徽标（与 Web 一致：正常状态不额外标注）。

import type { FacilityOperationalStatus } from "./types";

export function facilityStatusLabel(status: FacilityOperationalStatus | string | null | undefined): string {
  if (status === "unavailable") return "暂停使用";
  if (status === "partially_available") return "部分可用";
  return "";
}
