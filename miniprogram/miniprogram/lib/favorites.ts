// 「我的收藏」：wx storage key shumap.favorites，poiKey 字符串数组，
// 最新在前、按 poiKey 去重（对齐 Web 端 src/lib/storage/favorites.ts 的 toggle 语义：
// 已收藏则移除，未收藏则置顶）。纯函数核心 + storage 注入（同 recents.ts 范式）。

export const FAVORITES_KEY = "shumap.favorites";

/** 字符串 KV 抽象（wx storage 的 get/set 子集，单测注入内存实现）。 */
export interface FavoritesStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const wxStorage: FavoritesStorage = {
  get(key) {
    const value = wx.getStorageSync(key);
    return typeof value === "string" && value !== "" ? value : null;
  },
  set(key, value) {
    try {
      wx.setStorageSync(key, value);
    } catch {
      // 写入失败：静默降级（收藏是锦上添花，不影响主流程）。
    }
  },
};

/** 读收藏；缓存损坏/形状不对视为空。 */
export function readFavorites(storage: FavoritesStorage): string[] {
  const raw = storage.get(FAVORITES_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string" && item !== "");
}

/** 纯函数核心：已收藏则移除，未收藏则置顶。 */
export function toggleFavoriteEntry(entries: string[], poiKey: string): string[] {
  return entries.includes(poiKey)
    ? entries.filter((entry) => entry !== poiKey)
    : [poiKey, ...entries];
}

/** 默认实现：wx storage。返回切换后的列表。 */
export function toggleFavorite(poiKey: string, storage: FavoritesStorage = wxStorage): string[] {
  const next = toggleFavoriteEntry(readFavorites(storage), poiKey);
  storage.set(FAVORITES_KEY, JSON.stringify(next));
  return next;
}

/** 默认实现：wx storage 读取（页面展示用）。 */
export function listFavorites(storage?: FavoritesStorage): string[] {
  return readFavorites(storage ?? wxStorage);
}

export function isFavorite(poiKey: string, storage: FavoritesStorage = wxStorage): boolean {
  return readFavorites(storage).includes(poiKey);
}
