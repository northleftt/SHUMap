/*
 * guide-icons.js — 图标库的出厂种子
 *
 * 为什么要有注册表：图标原先是渲染层里用代码画的（地铁标、SHUTF 字标），
 * 改一个图标要改代码。现在统一放进注册表，按 id 引用；编辑器可以上传新图标、
 * 重命名、删除，任何线路或卡片都能复用同一个 id。
 *
 * 存储格式：
 *   svg    — 内联 SVG 标记字符串（矢量，随字号缩放，可用 currentColor 跟随文字色）
 *   asset  — 位图在素材库里的键（icon-<id>），位图落 R2，内容里只留这个键
 *   uri    — 内联位图 data URI。迁移前的写法，读得懂但不再写入（见下）
 *
 * 位图为什么不再内联：一枚 3840×3840 的地铁标 base64 后 595KB，曾占整份内容
 * 96% 的体积，而它在时间轴上只画 15px 高。内容是「一份文档」——前台每次打开
 * 整份下发，且每改一个字就存一版新快照，位图会跟着复制 N 份。改成素材引用后
 * 位图按 ETag 独立缓存，换图连内容都不必重新发一版。
 * 编辑器（ensureIcons → backfillIconAssets）会把种子与旧稿的内联位图自动补传
 * 成 asset，存量另有 scripts/guide-icons-to-assets.mjs。
 *
 * 出厂种子这三枚都只写 svg：矢量描摹本来就小（每枚几百字节），且能跟随文字色。
 *
 * group 决定编辑器图标库里的分组，也决定选择器里的排序：
 *   transit 交通标识（地铁、市域铁路、公交…）
 *   brand   校方与社团标识
 *   misc    其它
 *
 * 用户上传的图标写进 data.icons（随 JSON 导出／导入一起走），
 * 出厂种子只在 data.icons 缺失时兜底。
 */
window.GUIDE_ICON_SEED = [
  {
    id: "metro-sh",
    name: "上海地铁",
    group: "transit",
    note: "出厂图标 · 按官方标识描摹，正式发布前建议替换为官方矢量文件",
    svg:
      '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" role="img">' +
      '<circle cx="7" cy="7" r="6.4" fill="#e4002b"/>' +
      '<path d="M3.9 9.6V4.4l3.1 2.8 3.1-2.8v5.2" fill="none" stroke="#fff" ' +
      'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      "</svg>",
  },
  {
    id: "rail-sh",
    name: "市域铁路",
    group: "transit",
    note: "出厂图标 · 描摹通用市域/城际铁路标识，建议替换为官方矢量文件",
    svg:
      '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" role="img">' +
      '<circle cx="7" cy="7" r="6.4" fill="#1e6fb8"/>' +
      '<path d="M4.6 3.9h4.8v4.1a1.3 1.3 0 0 1-1.3 1.3H5.9A1.3 1.3 0 0 1 4.6 8z" ' +
      'fill="none" stroke="#fff" stroke-width="1.15" stroke-linejoin="round"/>' +
      '<path d="M4.9 6.4h4.2M5.3 11.1l1.1-1.6M8.7 11.1l-1.1-1.6" stroke="#fff" ' +
      'stroke-width="1.05" stroke-linecap="round"/>' +
      "</svg>",
  },
  {
    id: "bus-generic",
    name: "公交",
    group: "transit",
    note: "出厂图标 · 原稿的公交段只用黄底线路号，未配图标；需要时可在线路里选用",
    svg:
      '<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" role="img">' +
      '<circle cx="7" cy="7" r="6.4" fill="#f2b203"/>' +
      '<path d="M4.5 4.1h5v4.3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1z" fill="none" ' +
      'stroke="#3d2c00" stroke-width="1.1" stroke-linejoin="round"/>' +
      '<path d="M4.7 6.6h4.6" stroke="#3d2c00" stroke-width="1"/>' +
      '<circle cx="5.7" cy="8.2" r="0.62" fill="#3d2c00"/>' +
      '<circle cx="8.3" cy="8.2" r="0.62" fill="#3d2c00"/>' +
      '<path d="M5.4 10.6v0.8M8.6 10.6v0.8" stroke="#3d2c00" stroke-width="1" ' +
      'stroke-linecap="round"/>' +
      "</svg>",
  },
];
