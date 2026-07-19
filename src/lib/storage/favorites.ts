import { useLocalStore } from "./localStore";

const KEY = "shumap.favorites";

/** 收藏的 placeId 列表（最新在前）。 */
export function useFavorites(): {
  favorites: string[];
  isFavorite: (placeId: string) => boolean;
  toggleFavorite: (placeId: string) => void;
} {
  const [favorites, setFavorites] = useLocalStore<string[]>(KEY, []);
  return {
    favorites,
    isFavorite: (placeId) => favorites.includes(placeId),
    toggleFavorite: (placeId) =>
      setFavorites((prev) =>
        prev.includes(placeId) ? prev.filter((id) => id !== placeId) : [placeId, ...prev],
      ),
  };
}
