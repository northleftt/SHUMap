// 转发 / 分享到朋友圈 / 复制链接的公共辅助。
//
// 微信的规则（官方文档「转发」「分享到朋友圈」）：
//  - 页面**定义了 onShareAppMessage** 右上角菜单才会出现「转发」，右上角的
//    「复制链接」也跟着这一项一起解锁；不定义就是截图里那样灰掉的
//    「当前页面不可转发」+「复制链接」不可点。
//  - 「分享到朋友圈」额外要求**定义 onShareTimeline**（基础库 2.11.3+），
//    且必须先具备转发能力（onShareAppMessage）。朋友圈打开的是**单页模式**：
//    tabBar（含自定义 tabBar）不渲染、web-view / switchTab / 本地缓存等能力不可用，
//    所以 web-view 容器页（pages/webview）只开转发、不开朋友圈。
//
// 本文件只放纯函数 + 一个 wx 调用，页面里各自 return 这里拼好的对象。

/** 无具体主题时的兜底标题。 */
export const APP_SHARE_TITLE = "上海大学校园地图 SHUMap";

/** 卡片标题上限（微信卡片单行显示，过长会被截断成省略号）。 */
const TITLE_MAX = 28;

type QueryValue = string | number | null | undefined;

/** 拼查询串（不带前导 ?）：空值整项丢掉，键值统一 encodeURIComponent。 */
export function shareQuery(params: Record<string, QueryValue> = {}): string {
  return Object.keys(params)
    .filter((key) => {
      const value = params[key];
      return value !== undefined && value !== null && String(value) !== "";
    })
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join("&");
}

/** 转发卡片路径：微信要求页面绝对路径（以 / 开头），查询参数为空时不带 ?。 */
export function sharePath(page: string, params: Record<string, QueryValue> = {}): string {
  const path = page.startsWith("/") ? page : `/${page}`;
  const query = shareQuery(params);
  return query ? `${path}?${query}` : path;
}

/**
 * 卡片标题：有具体主题时拼「主题 · 后缀」，没有则回落 App 名；统一截到 TITLE_MAX。
 * 主题本身已经很长时不再拼后缀，避免整句被截得只剩前半个地名。
 */
export function shareTitle(subject?: string | null, suffix = "上海大学校园地图"): string {
  const text = (subject ?? "").trim();
  if (!text) return APP_SHARE_TITLE;
  const joined = suffix && text.length + suffix.length + 3 <= TITLE_MAX ? `${text} · ${suffix}` : text;
  return joined.length > TITLE_MAX ? joined.slice(0, TITLE_MAX) : joined;
}

/**
 * 显式打开分享菜单项。定义了 onShareAppMessage/onShareTimeline 后菜单默认就是可用的，
 * 这里再调一次是防御：部分基础库版本上「分享到朋友圈」需要 menus 里显式带
 * shareTimeline 才出现；老版本不认 menus 字段时整个调用失败也不影响转发。
 */
export function enableShareMenus(withTimeline = true): void {
  if (typeof wx === "undefined" || typeof wx.showShareMenu !== "function") return;
  try {
    wx.showShareMenu({
      withShareTicket: false,
      menus: withTimeline ? ["shareAppMessage", "shareTimeline"] : ["shareAppMessage"],
      fail: () => {
        // 老基础库不认 menus：退回只请求转发菜单，失败也无所谓（默认即可转发）。
        try {
          wx.showShareMenu({ withShareTicket: false });
        } catch {
          // 忽略：菜单可用性由 onShareAppMessage 的存在决定。
        }
      },
    });
  } catch {
    // 同上，纯防御调用，抛错不影响页面。
  }
}
