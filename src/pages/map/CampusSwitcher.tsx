import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { CampusConfig, CampusKey } from "../../lib/types";

/** M1 左上角校区切换 pill + 下拉。 */
export function CampusSwitcher({
  selectedCampus,
  campuses,
  onSelect,
}: {
  selectedCampus: CampusKey;
  campuses: CampusConfig[];
  onSelect: (campus: CampusKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = campuses.find((campus) => campus.key === selectedCampus);
  if (!current) throw new Error(`Map data contract violation: unknown campus ${selectedCampus}`);

  return (
    <div className="relative">
      <button
        type="button"
        className="flex h-9 items-center gap-1.5 rounded-full bg-surface px-4 text-body font-medium text-ink shadow-floating"
        onClick={() => setOpen((value) => !value)}
      >
        {current.label}
        <ChevronDown size={15} className={`text-sub transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-11 z-20 w-[128px] overflow-hidden rounded-2xl bg-surface p-1 shadow-floating">
            {campuses.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`flex h-9 w-full items-center rounded-xl px-3 text-left text-body ${
                  option.key === selectedCampus ? "bg-primary-container text-primary" : "text-ink"
                }`}
                onClick={() => {
                  setOpen(false);
                  onSelect(option.key);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
