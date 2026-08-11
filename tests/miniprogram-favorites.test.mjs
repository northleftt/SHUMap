// 小程序端「我的收藏」纯逻辑自验（node 直接跑，范式同 miniprogram-shuttle.test.mjs）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/map-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/favorites.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "favorites.cjs")}`,
]);

const require = createRequire(import.meta.url);
const favorites = require(join(outDir, "favorites.cjs"));

function memoryStorage() {
  const map = new Map();
  return {
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => map.set(key, value),
  };
}

// toggle 语义：未收藏置顶，已收藏移除（对齐 Web 端 toggleFavorite）
assert.deepEqual(favorites.toggleFavoriteEntry([], "a"), ["a"]);
assert.deepEqual(favorites.toggleFavoriteEntry(["a"], "b"), ["b", "a"], "新收藏置顶");
assert.deepEqual(favorites.toggleFavoriteEntry(["b", "a"], "a"), ["b"], "已收藏再 toggle = 移除");
assert.deepEqual(favorites.toggleFavoriteEntry(["a"], "a"), []);

// storage 注入端到端：读写往返 + isFavorite/listFavorites
{
  const storage = memoryStorage();
  favorites.toggleFavorite("place_x", storage);
  favorites.toggleFavorite("place_y", storage);
  assert.deepEqual(favorites.listFavorites(storage), ["place_y", "place_x"]);
  assert.equal(favorites.isFavorite("place_x", storage), true);
  assert.equal(favorites.isFavorite("place_z", storage), false);
  favorites.toggleFavorite("place_x", storage);
  assert.equal(favorites.isFavorite("place_x", storage), false);
  assert.deepEqual(favorites.listFavorites(storage), ["place_y"]);
}

// 坏数据防御：非 JSON / 非数组 / 非字符串项都视为空或过滤
{
  const storage = memoryStorage();
  storage.set(favorites.FAVORITES_KEY, "not json");
  assert.deepEqual(favorites.readFavorites(storage), []);
  storage.set(favorites.FAVORITES_KEY, '{"a":1}');
  assert.deepEqual(favorites.readFavorites(storage), []);
  storage.set(favorites.FAVORITES_KEY, '["a", 1, "", null, "b"]');
  assert.deepEqual(favorites.readFavorites(storage), ["a", "b"], "非字符串/空串项被过滤");
}

console.log("miniprogram-favorites: all assertions passed");
