import { apiGet } from "../api";
import { parseDiningScheduleResponse, parseMerchantStatusResponse, shanghaiToday } from "./schedule";
export function parseFacilityStatuses(value: unknown): Record<string, string> {
  const statuses = (value as { statuses?: unknown })?.statuses;
  if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) throw new Error("Invalid facility statuses");
  for (const status of Object.values(statuses)) if (!["available", "unavailable", "partially_available", "unknown"].includes(String(status))) throw new Error("Invalid facility status");
  return statuses as Record<string, string>;
}
export const fetchDiningSchedule = () => apiGet("/api/public/dining/schedule", { date: shanghaiToday() }).then(parseDiningScheduleResponse);
export const fetchMerchantStatuses = () => apiGet("/api/public/merchant-status").then(parseMerchantStatusResponse);
export const fetchFacilityStatuses = () => apiGet("/api/public/facility-status").then(parseFacilityStatuses);
