// 「最近查看」记录：wx storage key shumap.recents，{poiKey, viewedAt}[]，
// 最新在前、按 poiKey 去重、上限 20。纯函数核心 + storage 注入（同 loader.ts
// 的 deps 范式），node 单测用内存 Map，小程序里默认 wx storage。

export const RECENTS_KEY = "shumap.recents";
export const RECENTS_LIMIT = 20;

export interface RecentEntry {
  poiKey: string;
  viewedAt: number;
}

/** 字符串 KV 抽象（wx storage 的 get/set 子集，单测注入内存实现）。 */
export interface RecentsStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const wxStorage: RecentsStorage = {
  get(key) {
    const value = wx.getStorageSync(key);
    return typeof value === "string" && value !== "" ? value : null;
  },
  set(key, value) {
    try {
      wx.setStorageSync(key, value);
    } catch {
      // 超容量等写入失败：静默降级（最近查看是锦上添花，不影响主流程）。
    }
  },
};

/** 读记录；缓存损坏/形状不对视为空，不让坏数据卡死搜索面板。 */
export function readRecents(storage: RecentsStorage): RecentEntry[] {
  const raw = storage.get(RECENTS_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (item): item is RecentEntry =>
        !!item && typeof item === "object"
        && typeof (item as RecentEntry).poiKey === "string" && (item as RecentEntry).poiKey !== ""
        && typeof (item as RecentEntry).viewedAt === "number",
    )
    .slice(0, RECENTS_LIMIT);
}

/** 纯函数核心：新条目置顶、按 poiKey 去重、截到上限。 */
export function pushRecent(entries: RecentEntry[], poiKey: string, viewedAt: number): RecentEntry[] {
  return [
    { poiKey, viewedAt },
    ...entries.filter((entry) => entry.poiKey !== poiKey),
  ].slice(0, RECENTS_LIMIT);
}

/** 默认实现：wx storage。 */
export function addRecent(poiKey: string, storage: RecentsStorage = wxStorage): RecentEntry[] {
  const next = pushRecent(readRecents(storage), poiKey, Date.now());
  storage.set(RECENTS_KEY, JSON.stringify(next));
  return next;
}

/** 默认实现：wx storage 读取（页面展示用）。 */
export function listRecents(storage?: RecentsStorage): RecentEntry[] {
  return readRecents(storage ?? wxStorage);
}
