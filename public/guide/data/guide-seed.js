/*
 * guide-data.js — 返校指南电子版内容数据（原子卡片架构 · 全量重录版）
 *
 * 架构要点：cards 是一个扁平数组，一张卡片只承载一条路线（或一张图示 / 一组实景步骤）。
 * 卡片可以任意复制、重排、增删，页面长度不受 A4 约束。groups 负责给卡片分段，
 * 并携带 hub / campus 两个维度，供顶部 Tab 快速切换与目录索引使用。
 *
 * 三个出口（前台展示 / 可视化编辑器 / 导出渲染）共读这一份数据。
 * 用 .js 而不是 .json 是为了 file:// 直接打开时也能加载（fetch 会被 CORS 拦）。
 *
 * ── 数据来源与核对方式（重要）─────────────────────────────────────
 * 原稿：~/Documents/返校指南/*.ai 共 21 页（导出版本/ 下有对应 PDF）。
 * 提取时发现原稿的**数字全部取不出来**：页面里的数字用 Rockwell / MyriadPro
 * 子集字体，没有 ToUnicode 表，pdftotext 一律吐 U+FFFD。所以本文件的录入方式是：
 *   1. pdftotext -layout 取版面结构（站名、方向、中文说明、线路号的拉丁数字）
 *   2. pdftocairo -png -r 200 渲染整页，再逐栏裁切、逐页目视核对
 *      所有「耗时/票价」「步行米数」「发车时刻」「出站口编号」
 * 两条通道交叉验证：结构来自文字层，数字来自渲染图。
 * 页 02 与重录前的旧数据完全一致，可作为该方法的对照样本。
 *
 * ── 尚未录入的部分（不臆造，明确标注）───────────────────────────
 * · 附表 1（原稿 18-21 页）的**车次号表**：约 60 个 D/G 字头车次，
 *   数字同样只能目视识别。车次录错会直接导致学生错过中转，风险高于其它字段，
 *   因此这里只录入教程正文，车次表标为 pending，待专门一轮双人复核后再补。
 *   见 cards 里 id="sj-appendix-transfer" 的 pending 字段。
 * · 除页 02 外各页的「示意图 / 枢纽图」矢量素材尚未裁切
 *   （scripts/extract-figures.sh 的裁切框需逐页校准），因此暂不生成图示卡片，
 *   避免出现指向缺失素材的空卡。
 */
window.GUIDE_DATA = (function () {
  "use strict";

  /* ── 录入助手：只是为了少写重复字段，产出的仍是普通对象 ───────────
     编辑器按 cards.N.legs.M.name 这样的路径读写，所以运行期必须是纯数据。 */

  function stop(name, rails, o) {
    var leg = { type: "stop", name: name, marker: (o && o.marker) || "dot", rails: rails || [] };
    if (o) {
      if (o.exit) leg.exit = o.exit;
      if (o.note) leg.note = o.note;
      if (o.mergeTo) leg.mergeTo = o.mergeTo;
    }
    return leg;
  }
  function xfer(name, rails, o) {
    var leg = stop(name, rails, o);
    leg.marker = "transfer";
    return leg;
  }
  function end(name) {
    return { type: "stop", name: name, marker: "dot", terminal: true };
  }
  function walk(meters) {
    return { type: "walk", meters: meters, rails: ["walk"] };
  }
  function ride(rails, lines) {
    return { type: "ride", rails: rails, lines: lines };
  }
  /* 地铁：号码进色块，后接「号线」 */
  function metro(no, color, toward, note) {
    var ln = { kind: "metro", no: String(no), color: color, suffix: "号线", toward: toward };
    if (note) ln.note = note;
    return ln;
  }
  /* 名称即徽章（磁浮线这类没有号码的线路） */
  function badgeLine(name, color, toward) {
    return { kind: "metro", no: name, color: color, toward: toward };
  }
  /* 无色块、名称直接着色（公交、专线） */
  function bus(no, toward, o) {
    var ln = { kind: "bus", no: no, color: (o && o.color) || "bus", toward: toward };
    if (o && o.note) ln.note = o.note;
    if (o && o.notes) ln.notes = o.notes;
    return ln;
  }
  /* 无色块、深色正文（市域机场线：原稿是图标 + 纯文字） */
  function plainLine(name, color, toward) {
    return { kind: "plain", no: name, color: color, toward: toward };
  }

  var NO_HUAQIAO = "不要乘坐往花桥方向的列车";
  var EXIT2 = "（2号口出站）";

  /* 嘉定北 → 嘉定校区东门 的公共尾段：11 号线出站后换嘉定 13 路。
     原稿里 5 张卡片共用这一段，抽出来避免逐字重复出错。 */
  function tailJiadingEast13() {
    return [
      stop("嘉定北", ["walk"], { exit: EXIT2 }),
      walk(45),
      stop("平城路城北路", ["bus"]),
      ride(["bus"], [bus("嘉定13路", "往 南门公交站方向")]),
      stop("城中路塔城路", ["walk"]),
      walk(385),
      end("嘉定校区东门"),
    ];
  }
  /* 延长路 → 延长校区南门 的公共尾段 */
  function tailYanchangSouth() {
    return [
      stop("延长路", ["walk"], { exit: EXIT2 }),
      walk(400),
      end("延长校区南门"),
    ];
  }
  /* 上海大学 → 宝山校区北门 的公共尾段 */
  function tailBaoshanNorth() {
    return [
      stop("上海大学", ["walk"], { exit: EXIT2 }),
      walk(45),
      end("宝山校区北门"),
    ];
  }

  function route(o) {
    return {
      id: o.id,
      kind: "route",
      group: o.group,
      page: o.page,
      hub: o.hub,
      toward: o.toward,
      mode: o.mode,
      modeLabel: o.modeLabel,
      durationMin: o.durationMin,
      fareYuan: o.fareYuan,
      flags: o.flags || [],
      legs: o.legs,
    };
  }

  return {
    meta: {
      title: "上海大学",
      subtitle: "新生入校交通指南",
      edition: "2025 版 · 电子版",
      footnote: "点击枢纽条目可跳转对应卡片组",
      /* 版本管理：这两个字段随快照一起走，用于区分「同一份原稿的不同修订」 */
      version: "2025.1",
      revisedAt: "2026-08-03",
      revisionNote: "按原稿 21 页全量重录；数字经渲染图逐页目视核对",
      sourceNote: "原稿 2025 年版，共 21 页。数字层不可提取，见文件头注释。",
    },

    /* 线路配色表：键名同时用于 CSS 变量与时间轴轨道取色 */
    lineColors: {
      l1: "#e4002b", l2: "#8cc63e", l3: "#ffd100", l4: "#5b2d8e", l7: "#f3901d",
      l9: "#71c5e8", l10: "#c1a2ca", l11: "#871c2b", l15: "#bda26b", l17: "#bc8b5e",
      maglev: "#ee7b23",      /* 磁浮线 */
      airport: "#35689f",     /* 市域机场线 */
      bus: "#f2b203",
      bus185: "#5cb531",      /* 原稿里 185 路单独用绿色 */
      walk: "#b9bfc7", neutral: "#8f98a3",
    },

    /* ══════════════ 目录（仅 PDF 导出与打印使用） ══════════════
     * 移动端浏览走顶部 Tab + 目录抽屉，不再用这张页码表；
     * 但导出版本要与原稿第 0 页一致，所以数据完整保留。 */
    cover: {
      lead: "从下列枢纽出发…",
      hubs: [
        {
          id: "hongqiao", name: "虹桥枢纽", color: "#3aa17e",
          note: "（铁路上海虹桥站, 虹桥机场）",
          entries: [
            { label: "宝山校区", page: 1, arrow: "→", groupId: "hongqiao-baoshan" },
            { label: "嘉定校区", page: 2, arrow: "→", groupId: "hongqiao-jiading" },
            { label: "延长校区", page: 3, arrow: "→", groupId: "hongqiao-yanchang" },
            { label: "实景指引", page: 4, arrow: "—", groupId: "hongqiao-scene" },
          ],
        },
        {
          id: "shanghai-railway", name: "铁路上海站", color: "#c2a25e",
          note: "（上海长途客运总站）",
          entries: [
            { label: "宝山校区", page: 5, arrow: "→", groupId: "shanghai-baoshan" },
            { label: "嘉定校区", page: 6, arrow: "→", groupId: "shanghai-jiading" },
            { label: "延长校区", page: 7, arrow: "→", groupId: "shanghai-yanchang" },
            { label: "实景指引", page: 8, arrow: "—", groupId: "shanghai-scene" },
          ],
        },
        {
          id: "shanghai-south", name: "铁路上海南站", color: "#3f6ea8",
          entries: [
            { label: "宝山校区", page: 9, arrow: "→", groupId: "south-baoshan" },
            { label: "嘉定校区", page: 10, arrow: "→", groupId: "south-jiading" },
            { label: "延长校区", page: 11, arrow: "→", groupId: "south-yanchang" },
            { label: "实景指引", page: 12, arrow: "—", groupId: "south-scene" },
          ],
        },
        {
          id: "pudong-airport", name: "浦东机场", color: "#8cc63e",
          entries: [
            { label: "宝山校区", page: 13, arrow: "→", groupId: "pudong-baoshan" },
            { label: "嘉定校区", page: 14, arrow: "→", groupId: "pudong-jiading" },
            { label: "延长校区", page: 15, arrow: "→", groupId: "pudong-yanchang" },
            { label: "实景指引", page: 16, arrow: "—", groupId: "pudong-scene" },
          ],
        },
        {
          id: "songjiang", name: "铁路上海松江站", color: "#e8a08c",
          entries: [{ label: "各校区", page: 17, arrow: "→", groupId: "songjiang-all" }],
        },
        {
          id: "appendix", name: "附录1", color: "#9aa2ac",
          note: "（上海松江站换乘指南）",
          tail: "第18-21页",
          entries: [{ label: "中转教程", page: 18, arrow: "—", groupId: "songjiang-appendix" }],
        },
      ],
    },

    /* ══════════════ 到达目的地清单 ══════════════
     * 顶部第二排 Tab 的选项，也是选择器/目录里的短标签来源。
     * id 与 groups[].campus 对应；order 决定 Tab 与目录里的先后。
     * "scene" 不是校区而是实景指引，"all" 是不分校区的整页（松江、附表）。 */
    campuses: [
      { id: "baoshan", label: "宝山校区", short: "宝山" },
      { id: "jiading", label: "嘉定校区", short: "嘉定" },
      { id: "yanchang", label: "延长校区", short: "延长" },
      { id: "scene", label: "实景指引", short: "实景" },
      { id: "all", label: "各校区通用", short: "通用" },
    ],

    /* ══════════════ 卡片分组 ══════════════
     * hub / campus 供顶部 Tab 二维切换；page 保持原稿页序，导出时按它排版。 */
    groups: [
      { id: "hongqiao-baoshan", hub: "hongqiao", campus: "baoshan", page: 1, title: "虹桥枢纽 → 宝山校区", note: "原稿第 1 页 · 2 条方案" },
      { id: "hongqiao-jiading", hub: "hongqiao", campus: "jiading", page: 2, title: "虹桥枢纽 → 嘉定校区", note: "原稿第 2 页 · 3 条方案" },
      { id: "hongqiao-yanchang", hub: "hongqiao", campus: "yanchang", page: 3, title: "虹桥枢纽 → 延长校区", note: "原稿第 3 页 · 2 条方案" },
      { id: "hongqiao-scene", hub: "hongqiao", campus: "scene", page: 4, title: "虹桥枢纽 · 实景指引", note: "原稿第 4 页" },

      { id: "shanghai-baoshan", hub: "shanghai-railway", campus: "baoshan", page: 5, title: "铁路上海站 → 宝山校区", note: "原稿第 5 页 · 2 条方案" },
      { id: "shanghai-jiading", hub: "shanghai-railway", campus: "jiading", page: 6, title: "铁路上海站 → 嘉定校区", note: "原稿第 6 页 · 2 条方案" },
      { id: "shanghai-yanchang", hub: "shanghai-railway", campus: "yanchang", page: 7, title: "铁路上海站 → 延长校区", note: "原稿第 7 页 · 1 条方案" },
      { id: "shanghai-scene", hub: "shanghai-railway", campus: "scene", page: 8, title: "铁路上海站 · 实景指引", note: "原稿第 8 页" },

      { id: "south-baoshan", hub: "shanghai-south", campus: "baoshan", page: 9, title: "铁路上海南站 → 宝山校区", note: "原稿第 9 页 · 2 条方案" },
      { id: "south-jiading", hub: "shanghai-south", campus: "jiading", page: 10, title: "铁路上海南站 → 嘉定校区", note: "原稿第 10 页 · 3 条方案" },
      { id: "south-yanchang", hub: "shanghai-south", campus: "yanchang", page: 11, title: "铁路上海南站 → 延长校区", note: "原稿第 11 页 · 1 条方案" },
      { id: "south-scene", hub: "shanghai-south", campus: "scene", page: 12, title: "铁路上海南站 · 实景指引", note: "原稿第 12 页" },

      { id: "pudong-baoshan", hub: "pudong-airport", campus: "baoshan", page: 13, title: "浦东机场 → 宝山校区", note: "原稿第 13 页 · 1 条方案" },
      { id: "pudong-jiading", hub: "pudong-airport", campus: "jiading", page: 14, title: "浦东机场 → 嘉定校区", note: "原稿第 14 页 · 3 条方案" },
      { id: "pudong-yanchang", hub: "pudong-airport", campus: "yanchang", page: 15, title: "浦东机场 → 延长校区", note: "原稿第 15 页 · 1 条方案" },
      { id: "pudong-scene", hub: "pudong-airport", campus: "scene", page: 16, title: "浦东机场 · 实景指引", note: "原稿第 16 页" },

      { id: "songjiang-all", hub: "songjiang", campus: "all", page: 17, title: "松江枢纽 → 各校区", note: "原稿第 17 页 · 3 条方案" },
      { id: "songjiang-appendix", hub: "appendix", campus: "all", page: 18, title: "附表1 · 铁路上海松江站中转教程", note: "原稿第 18-21 页" },
    ],

    /* ══════════════ 原子卡片 ══════════════ */
    cards: [

      /* ─────────── 第 1 页 虹桥枢纽 → 宝山校区 ─────────── */
      route({
        id: "hq-bs-metro-a", group: "hongqiao-baoshan", page: 1,
        hub: { name: "虹桥枢纽", note: "（铁路上海虹桥站 虹桥机场）" },
        toward: "去往 宝山校区", mode: "metro", modeLabel: "地铁",
        durationMin: 75, fareYuan: 6,
        legs: [
          stop("虹桥火车站/虹桥2号航站楼", ["l2"]),
          ride(["l2"], [metro(2, "l2", "往浦东1号2号航站楼方向")]),
          xfer("静安寺", ["l7"]),
          ride(["l7"], [metro(7, "l7", "往美兰湖/祁华路方向")]),
        ].concat(tailBaoshanNorth()),
      }),
      route({
        id: "hq-bs-metro-b", group: "hongqiao-baoshan", page: 1,
        hub: { name: "虹桥枢纽", note: "（虹桥1号航站楼出发）" },
        toward: "去往 宝山校区", mode: "metro", modeLabel: "地铁",
        durationMin: 90, fareYuan: 5,
        legs: [
          stop("虹桥1号航站楼", ["l10"]),
          ride(["l10"], [metro(10, "l10", "往虹桥火车站方向")]),
          xfer("虹桥火车站", ["l2"]),
          ride(["l2"], [metro(2, "l2", "往浦东1号2号航站楼方向")]),
          xfer("静安寺", ["l7"]),
          ride(["l7"], [metro(7, "l7", "往美兰湖/祁华路方向")]),
        ].concat(tailBaoshanNorth()),
      }),

      /* ─────────── 第 2 页 虹桥枢纽 → 嘉定校区 ───────────
         这一页与重录前的旧数据逐字一致，作为提取方法的对照样本。 */
      route({
        id: "hq-jd-metro", group: "hongqiao-jiading", page: 2,
        hub: { name: "虹桥枢纽", note: "（铁路上海虹桥站 虹桥机场）" },
        toward: "去往 嘉定校区", mode: "metro", modeLabel: "地铁",
        durationMin: 75, fareYuan: 8,
        legs: [
          xfer("虹桥火车站", ["l10", "l2"]),
          xfer("虹桥2号航站楼", ["l10", "l2"]),
          stop("虹桥1号航站楼", ["l10", "l2"]),
          ride(["l10", "l2"], [
            metro(10, "l10", "往基隆路方向"),
            metro(2, "l2", "往浦东1号2号航站楼方向"),
          ]),
          stop("交通大学", ["l10", "l2"]),
          stop("江苏路", ["l10", "l2"], { mergeTo: ["l11"] }),
          ride(["l11"], [metro(11, "l11", "往嘉定北方向", NO_HUAQIAO)]),
        ].concat(tailJiadingEast13()),
      }),
      route({
        id: "hq-jd-bus-east", group: "hongqiao-jiading", page: 2,
        hub: { name: "虹桥枢纽", note: "（东交通中心出发）" },
        toward: "去往 嘉定校区", mode: "bus", modeLabel: "公交",
        durationMin: 65, fareYuan: 11,
        legs: [
          stop("虹桥枢纽东交通中心", ["bus"]),
          ride(["bus"], [bus("虹桥枢纽9路", "往 嘉定客运中心方向")]),
          stop("嘉定客运中心", ["walk"]),
          walk(530),
          stop("嘉定西站", ["bus"]),
          ride(["bus"], [bus("嘉定5路", "往 新城路车站方向")]),
          stop("塔城路梅园路", ["walk"]),
          walk(57),
          end("嘉定校区北门"),
        ],
      }),
      route({
        id: "hq-jd-bus-west", group: "hongqiao-jiading", page: 2,
        hub: { name: "虹桥枢纽", note: "（西交通中心出发）" },
        toward: "去往 嘉定校区", mode: "bus", modeLabel: "公交",
        durationMin: 50, fareYuan: 8,
        flags: ["需提前购票", "每日 4 班"],
        legs: [
          stop("虹桥枢纽西交通中心", ["bus"]),
          ride(["bus"], [bus("嘉虹1路", "往 南门公交站方向", {
            notes: [
              "请在 “嘉定客运中心” 公众号提前购票",
              "发车时刻表: 08:30  11:00  18:15  20:30",
            ],
          })]),
          stop("南门公交站", ["walk"]),
          walk(450),
          end("嘉定校区东门"),
        ],
      }),

      /* ——— 第 2 页的图示卡片：原稿矢量真图 + 百分比坐标热区 ———
         只有本页的素材已裁切（assets/figures/），其余页的裁切框需逐页校准，
         校准后按同样结构补卡即可。热区 w/h 是「参照卡片正文宽 728px 的像素」，
         渲染层会按容器实际宽度等比缩放，见 guide-render.js 的 HOT_REF。 */
      {
        id: "hq-jd-fig-route",
        kind: "figure",
        group: "hongqiao-jiading",
        page: 2,
        figure: "route-hongqiao-jiading",
        title: "示意图",
        caption: "三条方案的实际走向。图片取自原稿矢量文件，未经重绘。",
        hotspots: [
          {
            id: "h-jdb", x: 29, y: 13, w: 78, h: 42,
            title: "嘉定北站",
            body: "11 号线往嘉定北方向的终点段。出站请走 2 号口，站外换乘嘉定 13 路。",
            links: [
              { label: "在 SHUMap 中查看嘉定校区", href: "#shumap:jiading" },
              { label: "高德地图导航到嘉定北站", href: "https://uri.amap.com/marker?name=%E5%98%89%E5%AE%9A%E5%8C%97%E7%AB%99" },
            ],
          },
          {
            id: "h-nmgj", x: 40, y: 24, w: 132, h: 42,
            title: "南门公交站",
            body: "嘉虹 1 路与嘉定 13 路的共同落客点，步行 450 米可到嘉定校区东门。",
            links: [{ label: "查看嘉虹 1 路发车时刻", href: "#card:hq-jd-bus-west" }],
          },
          {
            id: "h-jdkyzx", x: 6.5, y: 39, w: 44, h: 156,
            title: "嘉定客运中心",
            body: "虹桥枢纽 9 路的终点站。下车后步行 530 米换乘嘉定 5 路。",
            links: [{ label: "查看该方案完整路线", href: "#card:hq-jd-bus-east" }],
          },
          {
            id: "h-jsl", x: 81, y: 68.5, w: 92, h: 40,
            title: "江苏路站",
            body: "10 号线 / 2 号线换乘 11 号线的关键站。11 号线在此分岔，务必确认列车终点为嘉定北。",
            links: [{ label: "查看 11 号线运营信息", href: "https://www.shmetro.com" }],
          },
          {
            id: "h-hq", x: 26, y: 92, w: 112, h: 38,
            title: "虹桥枢纽",
            body: "铁路上海虹桥站、虹桥机场 T1／T2 共用枢纽。地铁在 B2 层，长途与公交在东、西交通中心。",
            links: [{ label: "查看枢纽内部图", href: "#card:hq-jd-fig-hub" }],
          },
          {
            id: "h-jtdx", x: 66, y: 90, w: 112, h: 38,
            title: "交通大学站",
            body: "10 号线沿线站点，可作为市区中转参考。",
            links: [],
          },
        ],
      },

      {
        id: "hq-jd-fig-hub",
        kind: "figure",
        group: "hongqiao-jiading",
        page: 2,
        figure: "hub-hongqiao",
        title: "虹桥枢纽图",
        caption: "两个乘车点分居东西两侧，出站前先确认走哪一头。",
        hotspots: [
          {
            id: "h-bus9", x: 28, y: 20, w: 260, h: 70,
            title: "虹桥枢纽 9 路乘车点",
            body: "位于东侧交通枢纽 2 层。出铁路到达层后跟随“公交”指示牌步行约 6 分钟，终点为嘉定客运中心。",
            links: [{ label: "查看该方案完整路线", href: "#card:hq-jd-bus-east" }],
          },
          {
            id: "h-bus1", x: 23, y: 83, w: 210, h: 74,
            title: "嘉虹 1 路乘车点",
            body: "位于虹桥西交通中心 1 层。每日 4 班：08:30 / 11:00 / 18:15 / 20:30，需在“嘉定客运中心”公众号提前购票。",
            links: [{ label: "关注嘉定客运中心公众号购票", href: "#wechat:jdkyzx" }],
          },
          {
            id: "h-east", x: 48, y: 39, w: 56, h: 56,
            title: "虹桥东交通中心",
            body: "长途客运与市区公交集散点，虹桥枢纽 9 路在此发车。",
            links: [],
          },
          {
            id: "h-west", x: 7.4, y: 56, w: 52, h: 52,
            title: "虹桥西交通中心",
            body: "嘉虹 1 路在此发车，靠近铁路站西侧出口。",
            links: [],
          },
          {
            id: "h-rail", x: 21, y: 60, w: 96, h: 34,
            title: "虹桥火车站（地铁站）",
            body: "2 / 10 / 17 号线在此换乘。前往嘉定校区在此乘 10 号线或 2 号线。",
            links: [{ label: "查看地铁方案", href: "#card:hq-jd-metro" }],
          },
          {
            id: "h-t2", x: 52, y: 60, w: 126, h: 34,
            title: "虹桥2号航站楼站",
            body: "2 / 10 号线换乘站，机场到达可在此直接进站。",
            links: [],
          },
          {
            id: "h-t1", x: 79, y: 59, w: 130, h: 34,
            title: "虹桥1号航站楼站",
            body: "仅 10 号线经停。T1 到达的同学在此乘车。",
            links: [],
          },
        ],
      },

      /* ─────────── 第 3 页 虹桥枢纽 → 延长校区 ─────────── */
      route({
        id: "hq-yc-metro-a", group: "hongqiao-yanchang", page: 3,
        hub: { name: "虹桥枢纽", note: "（铁路上海虹桥站 虹桥机场）" },
        toward: "去往 延长校区", mode: "metro", modeLabel: "地铁",
        durationMin: 61, fareYuan: 5,
        legs: [
          stop("虹桥2号航站楼 / 虹桥火车站", ["l2"]),
          ride(["l2"], [metro(2, "l2", "往浦东1号2号航站楼方向")]),
          xfer("人民广场", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路/上海火车站方向")]),
        ].concat(tailYanchangSouth()),
      }),
      route({
        id: "hq-yc-metro-b", group: "hongqiao-yanchang", page: 3,
        hub: { name: "虹桥枢纽", note: "（虹桥1号航站楼出发）" },
        toward: "去往 延长校区", mode: "metro", modeLabel: "地铁",
        durationMin: 61, fareYuan: 5,
        legs: [
          stop("虹桥1号航站楼", ["l10"]),
          ride(["l10"], [metro(10, "l10", "往基隆路/新江湾城方向")]),
          xfer("陕西南路", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路/上海火车站方向")]),
        ].concat(tailYanchangSouth()),
      }),

      /* ─────────── 第 5 页 铁路上海站 → 宝山校区 ─────────── */
      route({
        id: "sh-bs-metro", group: "shanghai-baoshan", page: 5,
        hub: { name: "铁路上海站", note: "（上海长途客运总站）" },
        toward: "去往 宝山校区", mode: "metro", modeLabel: "地铁",
        durationMin: 50, fareYuan: 4,
        legs: [
          stop("上海火车站", ["l3", "l4"], { note: "下列两线列车均可乘坐" }),
          ride(["l3", "l4"], [
            metro(3, "l3", "往江杨北路方向"),
            metro(4, "l4", "往中山公园 上海体育场方向"),
          ]),
          xfer("镇坪路", ["l7"]),
          ride(["l7"], [metro(7, "l7", "往美兰湖/祁华路方向")]),
        ].concat(tailBaoshanNorth()),
      }),
      route({
        id: "sh-bs-bus", group: "shanghai-baoshan", page: 5,
        hub: { name: "铁路上海站", note: "（西南出站口出发）" },
        toward: "去往 宝山校区", mode: "bus", modeLabel: "公交",
        durationMin: 70, fareYuan: 2,
        flags: ["东南、西南口可免安检乘地铁1号线"],
        legs: [
          stop("铁路上海站西南出站口", ["walk"]),
          walk(445),
          stop("恒丰路天目西路（上海火车站）", ["bus185"]),
          ride(["bus185"], [bus("185路", "往 园康路市台路", { color: "bus185" })]),
          stop("上大路文海路", ["walk"]),
          walk(325),
          end("宝山校区南门"),
        ],
      }),

      /* ─────────── 第 6 页 铁路上海站 → 嘉定校区 ─────────── */
      route({
        id: "sh-jd-bus", group: "shanghai-jiading", page: 6,
        hub: { name: "铁路上海站", note: "（南广场出发）" },
        toward: "去往 嘉定校区", mode: "bus", modeLabel: "公交",
        durationMin: 60, fareYuan: 8,
        flags: ["每日 20 班"],
        legs: [
          stop("上海站南广场", ["walk"]),
          walk(270),
          stop("恒丰路秣陵路", ["bus"]),
          ride(["bus"], [bus("沪嘉专线", "往 南门公交站方向", {
            notes: [
              "发车时刻表：",
              "05:40  06:30  07:10  08:00  09:00  09:40  10:10",
              "10:40  11:30  12:30  13:30  14:30  15:40  16:50",
              "17:40  18:20  19:10  20:00  20:50  21:30",
            ],
          })]),
          stop("南门公交站", ["walk"]),
          walk(470),
          end("嘉定校区东门"),
        ],
      }),
      route({
        id: "sh-jd-metro", group: "shanghai-jiading", page: 6,
        hub: { name: "铁路上海站", note: "（上海长途客运总站）" },
        toward: "去往 嘉定校区", mode: "metro", modeLabel: "地铁",
        durationMin: 75, fareYuan: 8,
        legs: [
          stop("上海火车站", ["l3", "l4"], { note: "下列两线列车均可乘坐" }),
          ride(["l3", "l4"], [
            metro(3, "l3", "往江杨北路方向"),
            metro(4, "l4", "往中山公园 上海体育场方向"),
          ]),
          xfer("曹杨路", ["l11"]),
          ride(["l11"], [metro(11, "l11", "往嘉定北方向", NO_HUAQIAO)]),
        ].concat(tailJiadingEast13()),
      }),

      /* ─────────── 第 7 页 铁路上海站 → 延长校区 ─────────── */
      route({
        id: "sh-yc-metro", group: "shanghai-yanchang", page: 7,
        hub: { name: "铁路上海站", note: "（上海长途客运总站）" },
        toward: "去往 延长校区", mode: "metro", modeLabel: "地铁",
        durationMin: 17, fareYuan: 3,
        legs: [
          stop("上海火车站", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路/上海火车站方向")]),
        ].concat(tailYanchangSouth()),
      }),

      /* ─────────── 第 9 页 铁路上海南站 → 宝山校区 ─────────── */
      route({
        id: "ss-bs-metro-a", group: "south-baoshan", page: 9,
        hub: { name: "铁路上海南站", note: null },
        toward: "去往 宝山校区", mode: "metro", modeLabel: "方案1",
        durationMin: 50, fareYuan: 5,
        legs: [
          stop("上海南站", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路/上海火车站方向")]),
          xfer("常熟路", ["l7"]),
          ride(["l7"], [metro(7, "l7", "往美兰湖/祁华路方向")]),
        ].concat(tailBaoshanNorth()),
      }),
      route({
        id: "ss-bs-metro-b", group: "south-baoshan", page: 9,
        hub: { name: "铁路上海南站", note: null },
        toward: "去往 宝山校区", mode: "metro", modeLabel: "方案2",
        durationMin: 56, fareYuan: 5,
        legs: [
          stop("上海南站", ["l3"]),
          ride(["l3"], [metro(3, "l3", "往江杨北路方向")]),
          xfer("镇坪路", ["l7"]),
          ride(["l7"], [metro(7, "l7", "往美兰湖/祁华路方向")]),
        ].concat(tailBaoshanNorth()),
      }),

      /* ─────────── 第 10 页 铁路上海南站 → 嘉定校区 ─────────── */
      route({
        id: "ss-jd-metro-a", group: "south-jiading", page: 10,
        hub: { name: "铁路上海南站", note: null },
        toward: "去往 嘉定校区", mode: "metro", modeLabel: "地铁",
        durationMin: 95, fareYuan: 7,
        legs: [
          stop("上海南站", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路方向")]),
          xfer("徐家汇", ["l11"]),
          ride(["l11"], [metro(11, "l11", "往嘉定北方向", NO_HUAQIAO)]),
        ].concat(tailJiadingEast13()),
      }),
      route({
        id: "ss-jd-metro-b", group: "south-jiading", page: 10,
        hub: { name: "铁路上海南站", note: "（经上海西站换乘）" },
        toward: "去往 嘉定校区", mode: "metro", modeLabel: "地铁",
        durationMin: 90, fareYuan: 7,
        legs: [
          stop("上海南站", ["l15"]),
          ride(["l15"], [metro(15, "l15", "往顾村公园方向")]),
          xfer("上海西站", ["l11"]),
          ride(["l11"], [metro(11, "l11", "往嘉定北方向", NO_HUAQIAO)]),
        ].concat(tailJiadingEast13()),
      }),
      route({
        id: "ss-jd-bus", group: "south-jiading", page: 10,
        hub: { name: "铁路上海南站", note: "（南广场市郊公交出发）" },
        toward: "去往 嘉定校区", mode: "bus", modeLabel: "公交",
        durationMin: 110, fareYuan: 12,
        flags: ["每日 19 班"],
        legs: [
          stop("上海南站出站口", ["walk"], { note: "进入南站地下通道, 前往市郊公交站台" }),
          walk(500),
          stop("上海南站（南广场）", ["bus"]),
          ride(["bus"], [bus("上嘉线", "往 嘉定客运中心方向", {
            notes: [
              "发车时刻表：",
              "06:00  06:40  07:20  08:10  09:00  09:50",
              "10:40  11:30  12:20  13:00  13:40  14:20",
              "15:10  16:50  17:40  18:40  19:20  20:10",
              "21:00",
            ],
          })]),
          stop("永盛路福海路", ["bus"]),
          ride(["bus"], [bus("嘉定5路", "往 新城路车站方向")]),
          stop("塔城路梅园路", ["walk"]),
          walk(57),
          end("嘉定校区东门"),
        ],
      }),

      /* ─────────── 第 11 页 铁路上海南站 → 延长校区 ─────────── */
      route({
        id: "ss-yc-metro", group: "south-yanchang", page: 11,
        hub: { name: "铁路上海南站", note: null },
        toward: "去往 延长校区", mode: "metro", modeLabel: "地铁",
        durationMin: 43, fareYuan: 4,
        legs: [
          stop("上海南站", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路/上海火车站方向")]),
        ].concat(tailYanchangSouth()),
      }),

      /* ─────────── 第 13 页 浦东机场 → 宝山校区 ─────────── */
      route({
        id: "pd-bs-metro", group: "pudong-baoshan", page: 13,
        hub: { name: "浦东机场", note: null },
        toward: "去往 宝山校区", mode: "metro", modeLabel: "地铁",
        durationMin: 125, fareYuan: 8,
        legs: [
          stop("浦东1号2号航站楼", ["l2"]),
          ride(["l2"], [metro(2, "l2", "往国家会展中心方向")]),
          xfer("静安寺", ["l7"]),
          ride(["l7"], [metro(7, "l7", "往美兰湖/祁华路方向")]),
        ].concat(tailBaoshanNorth()),
      }),

      /* ─────────── 第 14 页 浦东机场 → 嘉定校区 ─────────── */
      route({
        id: "pd-jd-maglev", group: "pudong-jiading", page: 14,
        hub: { name: "浦东机场", note: "（磁浮线出发）" },
        toward: "去往 嘉定校区", mode: "maglev", modeLabel: "磁浮",
        durationMin: 115, fareYuan: 49,
        legs: [
          stop("浦东1号2号航站楼", ["maglev"]),
          ride(["maglev"], [badgeLine("磁浮线", "maglev", "往龙阳路方向")]),
          xfer("龙阳路", ["l2"]),
          ride(["l2"], [metro(2, "l2", "往国家会展中心方向")]),
          xfer("江苏路", ["l11"]),
          ride(["l11"], [metro(11, "l11", "往嘉定北方向", NO_HUAQIAO)]),
        ].concat(tailJiadingEast13()),
      }),
      route({
        id: "pd-jd-airport", group: "pudong-jiading", page: 14,
        hub: { name: "浦东机场", note: "（市域机场线出发）" },
        toward: "去往 嘉定校区", mode: "airport", modeLabel: "市域线",
        durationMin: 120, fareYuan: 36,
        legs: [
          stop("浦东1号2号航站楼", ["airport"]),
          ride(["airport"], [plainLine("市域机场线", "airport", "往虹桥2号航站楼方向")]),
          stop("虹桥2号航站楼", ["walk"]),
          walk(200),
          stop("虹桥枢纽东交通中心", ["bus"]),
          ride(["bus"], [bus("虹桥枢纽9路", "往 嘉定客运中心方向")]),
          stop("嘉定客运中心", ["walk"]),
          walk(530),
          stop("嘉定西站", ["bus"]),
          ride(["bus"], [bus("嘉定5路", "往 新城路车站方向")]),
          stop("塔城路梅园路", ["walk"]),
          walk(57),
          end("嘉定校区北门"),
        ],
      }),
      route({
        id: "pd-jd-metro", group: "pudong-jiading", page: 14,
        hub: { name: "浦东机场", note: null },
        toward: "去往 嘉定校区", mode: "metro", modeLabel: "地铁",
        durationMin: 151, fareYuan: 12,
        legs: [
          stop("浦东1号2号航站楼", ["l2"]),
          ride(["l2"], [metro(2, "l2", "往国家会展中心方向")]),
          xfer("江苏路", ["l11"]),
          ride(["l11"], [metro(11, "l11", "往嘉定北方向", NO_HUAQIAO)]),
        ].concat(tailJiadingEast13()),
      }),

      /* ─────────── 第 15 页 浦东机场 → 延长校区 ─────────── */
      route({
        id: "pd-yc-metro", group: "pudong-yanchang", page: 15,
        hub: { name: "浦东机场", note: null },
        toward: "去往 延长校区", mode: "metro", modeLabel: "地铁",
        durationMin: 94, fareYuan: 7,
        legs: [
          stop("浦东1号2号航站楼", ["l2"]),
          ride(["l2"], [metro(2, "l2", "往国家会展中心方向")]),
          xfer("人民广场", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路/上海火车站方向")]),
        ].concat(tailYanchangSouth()),
      }),

      /* ─────────── 第 17 页 松江枢纽 → 各校区 ─────────── */
      route({
        id: "sj-bs-metro", group: "songjiang-all", page: 17,
        hub: { name: "松江枢纽", note: "（铁路上海松江站）" },
        toward: "去往 宝山校区", mode: "metro", modeLabel: "宝山",
        durationMin: 110, fareYuan: 8,
        legs: [
          stop("上海松江站", ["l9"]),
          ride(["l9"], [metro(9, "l9", "往曹路方向")]),
          xfer("肇嘉浜路", ["l7"]),
          ride(["l7"], [metro(7, "l7", "往美兰湖/祁华路方向")]),
        ].concat(tailBaoshanNorth()),
      }),
      route({
        id: "sj-jd-metro", group: "songjiang-all", page: 17,
        hub: { name: "松江枢纽", note: "（铁路上海松江站）" },
        toward: "去往 嘉定校区", mode: "metro", modeLabel: "嘉定",
        durationMin: 145, fareYuan: 12,
        legs: [
          stop("上海松江站", ["l9"]),
          ride(["l9"], [metro(9, "l9", "往曹路方向")]),
          xfer("徐家汇", ["l11"]),
          ride(["l11"], [metro(11, "l11", "往嘉定北方向", NO_HUAQIAO)]),
        ].concat(tailJiadingEast13()),
      }),
      route({
        id: "sj-yc-metro", group: "songjiang-all", page: 17,
        hub: { name: "松江枢纽", note: "（铁路上海松江站）" },
        toward: "去往 延长校区", mode: "metro", modeLabel: "延长",
        durationMin: 105, fareYuan: 8,
        legs: [
          stop("上海松江站", ["l9"]),
          ride(["l9"], [metro(9, "l9", "往曹路方向")]),
          xfer("徐家汇", ["l1"]),
          ride(["l1"], [metro(1, "l1", "往富锦路/上海火车站方向")]),
          stop("延长路", ["walk"], { exit: EXIT2 }),
          walk(400),
          end("延长校区西门"),
        ],
      }),

      /* ══════════════ 实景指引卡片（原稿 4 / 8 / 12 / 16 页） ══════════════
       * kind:"steps" —— 分节的编号步骤。photo 字段留空：照片素材需先用
       * scripts/extract-photos.sh 从原稿导出，导出后把文件名填进 photo 即可。 */
      {
        id: "hq-scene", kind: "steps", group: "hongqiao-scene", page: 4,
        hub: { name: "虹桥枢纽", note: "（铁路上海虹桥站 虹桥机场）" },
        toward: "实景指引",
        sections: [
          {
            title: "从虹桥站去往虹桥枢纽西综合交通中心（嘉虹1线）：",
            accent: "#d6417f",
            steps: [
              { text: "火车站到达层往西（虹桥商务区）方向走" },
              { text: "找到 P7/P10 停车场" },
              { text: "坐扶梯到地上 1 层" },
              { text: "找到对应站台" },
            ],
          },
          {
            title: "从虹桥站/虹桥机场去往市域线/虹桥枢纽东综合交通中心（虹桥枢纽9路）：",
            accent: "#e4002b",
            steps: [
              { text: "火车站到达层往东（2号航站楼）走, 穿过地下通道" },
              { text: "一直向前走, 即可找到市域机场线车站" },
              { text: "乘坐公交需要继续往前走，直到看到圆形天井", note: "（从机场到达层出来后同样可以找到）" },
              { text: "上楼，找到 2 层的 2 号候车室走进去" },
            ],
          },
        ],
      },
      {
        id: "sh-scene", kind: "steps", group: "shanghai-scene", page: 8,
        hub: { name: "铁路上海站", note: "（上海长途客运总站）" },
        toward: "实景指引",
        sections: [
          {
            title: "出站口选择",
            steps: [
              { text: "东北、东南出口可以免安检乘坐地铁，但携带大件行李的同学，请前往西南、西北出口出站。" },
              { text: "前往乘坐公交沪嘉专线、185路的同学，建议走西南出口出站。" },
            ],
            bare: true,
          },
        ],
      },
      {
        id: "ss-scene", kind: "steps", group: "south-scene", page: 12,
        hub: { name: "铁路上海南站", note: null },
        toward: "实景指引",
        sections: [
          {
            title: "从上海南站去往南广场公交枢纽（上嘉线）：",
            steps: [
              { text: "进入地下区域" },
              { text: "向南广场公交枢纽（郊），不要去（市）" },
              { text: "继续沿指示牌走" },
              { text: "进入地下通道，前往南广场公交枢纽方向" },
              { text: "继续向前" },
              { text: "到达上嘉线站厅，前往站台" },
            ],
          },
        ],
      },
      {
        id: "pd-scene", kind: "steps", group: "pudong-scene", page: 16,
        hub: { name: "浦东机场", note: null },
        toward: "实景指引",
        sections: [
          {
            title: "从航站楼去往地铁 / 磁浮 / 市域机场线：",
            steps: [
              { text: "机场（T1/T2 航站楼）到达后，根据指示牌往联络通道走", note: "（推荐前往中间的联络通道）" },
              { text: "到达联络通道后，继续往里" },
              { text: "在中间位置即可看到地铁2号线/磁浮线/市域机场线的车站入口" },
            ],
          },
          {
            title: "市域机场线车站出入口",
            bare: true,
            steps: [
              { text: "车站共有 6 个出入口" },
              { text: "其中 1~3 号口只有垂直电梯" },
              { text: "4~6 号口只有扶手电梯" },
              { text: "行李较多的同学, 推荐前往 1-3 号口（中间通道）" },
            ],
          },
        ],
      },

      /* ══════════════ 附表1 中转教程（原稿 18-21 页） ══════════════ */
      {
        id: "sj-appendix-transfer", kind: "steps", group: "songjiang-appendix", page: 18,
        hub: { name: "附表1", note: "（铁路上海松江站中转教程）" },
        toward: "中转教程",
        intro: "松江枢纽离我校较远，我们建议采用“铁路中转”，前往市内更加接近我校的铁路客站以节约时间。" +
               "推荐去往宝山校区、延长校区的同学前往上海南站中转；去往嘉定校区的同学前往上海虹桥站中转。",
        sections: [
          {
            title: "第一步　确定下车位置",
            bare: true,
            steps: [
              { text: "铁路上海松江站分南、北两区，其中 1、2 站台位于南区，3-10 站台位于北区。" },
              { text: "购买第一程车票前往上海松江站的 SHUer 需要提前判断出自己所乘坐的列车将会停靠在哪个区域，以便后续在该站中转。" },
            ],
          },
          {
            title: "第二步　查询中转选择",
            bare: true,
            steps: [
              { text: "北区检票口为 1A/B–10A/B，南区检票口为 1-2。" },
              { text: "原稿用颜色区分终点：绿色车次可前往上海虹桥，橙色车次可前往上海南站，黑色车次可前往上海站。" },
              { text: "图例读法：左侧「时 分」为从上海松江站开出的时刻，右侧为车次与到达目的地时间。" },
            ],
          },
        ],
        /* 车次号表暂缺：约 60 个 D/G 字头车次，原稿数字层不可提取，只能目视识别。
           录错车次的后果（学生错过中转）比其它字段严重，故留待专门一轮双人复核。 */
        pending: {
          label: "车次号表待录入",
          detail: "原稿 18-21 页含约 60 个 D/G 字头车次及其时刻。原稿数字层不可提取，" +
                  "需目视逐条识别；因录错会直接导致错过中转，本轮不臆造，留待双人复核后补录。",
        },
      },
    ],
  };
})();
