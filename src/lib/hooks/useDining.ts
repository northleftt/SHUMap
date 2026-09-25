import { getDiningSchedule, getMerchantStatus } from "../api/public";
import { shanghaiToday, type DiningScheduleResponse, type MerchantLifecycle } from "../dining/schedule";
import { useAsyncData } from "./useAsyncData";

export type DiningScheduleState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; schedule: DiningScheduleResponse };

/**
 * 就餐实时数据源（GET /api/public/dining/schedule）：日型 + 供餐时段 + 当天开放安排。
 * 日期取上海时区的今天，与 worker 判定口径一致。
 */
export function useDiningSchedule(): DiningScheduleState {
  const date = shanghaiToday();
  const { state } = useAsyncData((signal) => getDiningSchedule(date, signal), [date]);
  if (state.status === "loading") return { status: "loading" };
  if (state.status === "error") return { status: "error", message: state.message };
  return { status: "ready", schedule: state.data };
}

export type MerchantStatusState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; statuses: Record<string, MerchantLifecycle> };

/** 商户营业状态实时通道（GET /api/public/merchant-status）。 */
export function useMerchantStatus(): MerchantStatusState {
  const { state } = useAsyncData((signal) => getMerchantStatus(signal), []);
  if (state.status === "loading") return { status: "loading" };
  if (state.status === "error") return { status: "error", message: state.message };
  return { status: "ready", statuses: state.data.statuses };
}
