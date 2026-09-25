// Pure display model shared in behavior with the native mini-program mirror.
export interface DiningFacility {
  id: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  floorId: string | null;
  content: Record<string, unknown>;
}
export interface DiningFacilityFloor { floorId: string; levelCode: string; displayName: string }

export function diningFacilities(
  facilities: readonly DiningFacility[], floors: readonly DiningFacilityFloor[],
  statuses: Record<string, string> | null, selectedFloorId?: string,
) {
  const byId = new Map(floors.map(floor => [floor.floorId, floor]));
  return facilities.filter(f => selectedFloorId === undefined || f.floorId === selectedFloorId).map(f => {
    const floor = f.floorId ? byId.get(f.floorId) : undefined;
    const location = typeof f.content.locationDescription === "string" ? f.content.locationDescription.trim() : "";
    const code = floor?.levelCode.replace(/^F(\d+)$/, "$1F");
    const status = statuses?.[f.id];
    return {
      id: f.id, name: f.displayName || f.typeName, typeCode: f.typeCode,
      location: selectedFloorId ? location : [code || "楼层待完善", location].filter(Boolean).join(" · "),
      statusLabel: status === "unavailable" ? "暂停使用" : status === "partially_available" ? "部分可用" : "",
    };
  });
}

/** Keep unassigned, hidden-floor and stale-floor merchants reachable, exactly once. */
export function ungroupedMerchants<T extends { floorId: string | null }>(merchants: readonly T[], floors: readonly DiningFacilityFloor[]): T[] {
  const ids = new Set(floors.map(f => f.floorId));
  return merchants.filter(m => !m.floorId || !ids.has(m.floorId));
}
