import { useLocalStore } from "./localStore";

const KEY = "shumap.recents";
const MAX_RECENTS = 20;

export interface RecentView {
  placeId: string;
  viewedAt: string;
}

/** 最近查看（最新在前，去重，上限 20）。 */
export function useRecents(): {
  recents: RecentView[];
  addRecent: (placeId: string) => void;
  clearRecents: () => void;
} {
  const [recents, setRecents] = useLocalStore<RecentView[]>(KEY, []);
  return {
    recents,
    addRecent: (placeId) =>
      setRecents((prev) =>
        [{ placeId, viewedAt: new Date().toISOString() }, ...prev.filter((item) => item.placeId !== placeId)].slice(0, MAX_RECENTS),
      ),
    clearRecents: () => setRecents([]),
  };
}
