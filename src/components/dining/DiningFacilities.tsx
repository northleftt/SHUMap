import { useNavigate } from "react-router-dom";
import { SectionHeader } from "../ui/SectionHeader";
import { FacilityGlyph, resolveFacilityIconKey } from "../../lib/facilityIcons";
import { diningFacilities, type DiningFacility, type DiningFacilityFloor } from "../../lib/dining/facilities";

export function DiningFacilities({ facilities, floors, statuses, error, loading, placeId, floorId, hasPlan = false, iconKeyByTypeCode }: {
  facilities: readonly DiningFacility[]; floors: readonly DiningFacilityFloor[];
  statuses: Record<string, string> | null; error?: string; loading?: boolean;
  placeId: string; floorId?: string; hasPlan?: boolean; iconKeyByTypeCode?: ReadonlyMap<string, string | null>;
}) {
  const navigate = useNavigate();
  const rows = diningFacilities(facilities, floors, statuses, floorId);
  if (!rows.length) return null;
  return <section className="mt-4" data-testid="dining-facilities">
    <SectionHeader title={floorId ? "本层设施" : "公共设施"} action={
      floorId ? hasPlan && <button type="button" className="text-primary" onClick={() => navigate(`/places/${encodeURIComponent(placeId)}/floors?floor=${encodeURIComponent(floorId)}&view=plan`)}>查看平面图 ›</button>
        : <button type="button" className="text-primary" onClick={() => navigate(`/places/${encodeURIComponent(placeId)}/floors?floor=all`)}>全部设施 ›</button>
    } />
    {error ? <p className="mt-2 text-aux text-error">设施状态加载失败，请稍后重试</p> : loading ? <p className="mt-2 text-aux text-sub">正在加载设施状态…</p> : null}
    <div className="mt-2 divide-y divide-line">
      {rows.map(row => <div key={row.id} className="flex items-start gap-3 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-container text-primary"><FacilityGlyph iconKey={resolveFacilityIconKey(row.typeCode, iconKeyByTypeCode ?? null)} size={18} /></span>
        <div className="min-w-0 flex-1"><div className="text-body font-semibold">{row.name}</div>{row.location && <div className="mt-0.5 break-words text-aux text-sub">{row.location}</div>}</div>
        {row.statusLabel && <span className="shrink-0 text-aux text-warning">{row.statusLabel}</span>}
      </div>)}
    </div>
  </section>;
}
