/*
 * guide-icons.js — 图标库的出厂种子
 *
 * 为什么要有注册表：图标原先是渲染层里用代码画的（地铁标、SHUTF 字标），
 * 改一个图标要改代码。现在统一放进注册表，按 id 引用；编辑器可以上传新图标、
 * 重命名、删除，任何线路或卡片都能复用同一个 id。
 *
 * 存储格式二选一：
 *   svg  — 内联 SVG 标记字符串（矢量，随字号缩放，可用 currentColor 跟随文字色）
 *   uri  — data URI（编辑器上传 PNG/SVG 时用 FileReader 转成的 base64）
 * 两者都能在 <foreignObject> 里画出来，所以单卡片导出 PNG 不会丢图标。
 * 不要存相对路径 —— 导出时 <foreignObject> 加载不了外部文件，会是空白。
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
  {
    id: "brand-shutf",
    name: "SHUTF 字标",
    group: "brand",
    note: "出厂占位 · 建议上传官方矢量文件替换",
    ratio: 132 / 46,
    svg:
      '<svg viewBox="0 0 132 46" xmlns="http://www.w3.org/2000/svg" role="img">' +
      '<polygon points="96,3 126,3 126,30 118,22 118,14 104,14" fill="#1e80c1"/>' +
      '<polygon points="108,26 126,8 126,30" fill="#1e80c1" opacity="0.55"/>' +
      '<text x="2" y="40" font-family="\'Times New Roman\',Songti SC,serif" font-size="27" ' +
      'font-weight="700" letter-spacing="0.02em" fill="#0f172a">SHUTF</text>' +
      '<path d="M2 43.4 H128" stroke="#0f172a" stroke-width="1.4"/>' +
      '<path d="M77 12 h13 M83.5 12 v22" stroke="#0f172a" stroke-width="2.1"/>' +
      "</svg>",
  },
];
