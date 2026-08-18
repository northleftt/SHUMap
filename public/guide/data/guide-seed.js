/*
 * guide-seed.js — 返校指南电子版内容数据（schema v2 · 原子卡片架构 · 全量重录版）
 *
 * 架构要点（v2）：cards 是一个扁平数组，一张卡片只承载一条路线（或一张图示 /
 * 一组实景步骤），卡片顺序即展示与打印顺序。v1 的 groups 分段层已删除：
 * 每张卡片直接携带 hub / campus 两个 id，供顶部 Tab 二维切换与目录索引。
 * 顶层 hubs 由 v1 cover.hubs 提升而来（去掉了 PDF 目录用的 page/entries/tail），
 * 新增 guideFigure / guideVideo / remark 三个枢纽级媒体与备注字段。
 * 路线卡里 v1 的 hub 对象 {name,note} 已改名 origin，hub 现在是枢纽 id 字符串。
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

window.GUIDE_DATA = {
  "schema": 2,
  "meta": {
    "title": "上海大学",
    "subtitle": "新生入校交通指南",
    "edition": "2025 版 · 电子版",
    "version": "2025.1",
    "revisedAt": "2026-08-03",
    "revisionNote": "按原稿 21 页全量重录；数字经渲染图逐页目视核对"
  },
  "lineColors": {
    "l1": { "fill": "#E3002B", "text": "#ffffff", "label": "1号线" },
    "l2": { "fill": "#82BF25", "text": "#111111", "label": "2号线" },
    "l3": { "fill": "#FCD600", "text": "#111111", "label": "3号线" },
    "l4": { "fill": "#461D84", "text": "#ffffff", "label": "4号线" },
    "l7": { "fill": "#ED6F00", "text": "#111111", "label": "7号线" },
    "l9": { "fill": "#87CAED", "text": "#111111", "label": "9号线" },
    "l10": { "fill": "#C6AFD4", "text": "#111111", "label": "10号线" },
    "l11": { "fill": "#871C2B", "text": "#ffffff", "label": "11号线" },
    "l15": { "fill": "#BCA886", "text": "#111111", "label": "15号线" },
    "l17": { "fill": "#BC796F", "text": "#ffffff", "label": "17号线" },
    "maglev": { "fill": "#008B9A", "text": "#ffffff", "label": "磁浮线" },
    "airport": { "fill": "#898989", "text": "#ffffff", "label": "市域线" },
    "bus": { "fill": "#F2B203", "text": "#111111", "label": "公交" },
    "bus185": { "fill": "#5CB531", "text": "#111111", "label": "185路" },
    "walk": { "fill": "#B9BFC7", "text": "#111111", "label": "步行" },
    "neutral": { "fill": "#8F98A3", "text": "#ffffff", "label": "中性" }
  },
  "campuses": [
    {
      "id": "baoshan",
      "label": "宝山校区",
      "short": "宝山"
    },
    {
      "id": "jiading",
      "label": "嘉定校区",
      "short": "嘉定"
    },
    {
      "id": "yanchang",
      "label": "延长校区",
      "short": "延长"
    },
    {
      "id": "all",
      "label": "各校区通用",
      "short": "通用"
    }
  ],
  "hubs": [
    {
      "id": "hongqiao",
      "name": "虹桥枢纽",
      "note": "（铁路上海虹桥站, 虹桥机场）",
      "color": "#3aa17e",
      "order": 1,
      "guideFigures": [],
      "guideVideos": [],
      "remark": "",
      "sceneGuide": {
        "sections": [
          {
            "title": "从虹桥站去往虹桥枢纽西综合交通中心（嘉虹1线）：",
            "accent": "#d6417f",
            "campuses": ["jiading"],
            "steps": [
              {
                "text": "火车站到达层往西（虹桥商务区）方向走",
                "figure": "/guide/figures/scene/hongqiao-west-1.jpg"
              },
              {
                "text": "找到 P7/P10 停车场",
                "figure": "/guide/figures/scene/hongqiao-west-2.jpg"
              },
              {
                "text": "坐扶梯到地上 1 层",
                "figure": "/guide/figures/scene/hongqiao-west-3.jpg"
              },
              {
                "text": "找到对应站台",
                "figure": "/guide/figures/scene/hongqiao-west-4.jpg"
              }
            ]
          },
          {
            "title": "从虹桥站/虹桥机场去往市域线/虹桥枢纽东综合交通中心（虹桥枢纽9路）：",
            "accent": "#e4002b",
            "campuses": ["jiading"],
            "steps": [
              {
                "text": "火车站到达层往东（2号航站楼）走, 穿过地下通道",
                "figure": "/guide/figures/scene/hongqiao-east-1.jpg"
              },
              {
                "text": "一直向前走, 即可找到市域机场线车站",
                "figure": "/guide/figures/scene/hongqiao-east-2.jpg"
              },
              {
                "text": "乘坐公交需要继续往前走，直到看到圆形天井",
                "note": "（从机场到达层出来后同样可以找到）",
                "figure": "/guide/figures/scene/hongqiao-east-3.jpg"
              },
              {
                "text": "上楼，找到 2 层的 2 号候车室走进去",
                "figure": "/guide/figures/scene/hongqiao-east-4.jpg"
              }
            ]
          }
        ]
      }
    },
    {
      "id": "shanghai-railway",
      "name": "铁路上海站",
      "note": "（上海长途客运总站）",
      "color": "#c2a25e",
      "order": 2,
      "guideFigures": [],
      "guideVideos": [],
      "remark": "",
      "sceneGuide": {
        "sections": [
          {
            "title": "出站口选择",
            "steps": [
              {
                "text": "东北、东南出口可以免安检乘坐地铁，但携带大件行李的同学，请前往西南、西北出口出站。"
              },
              {
                "text": "前往乘坐公交沪嘉专线、185路的同学，建议走西南出口出站。"
              }
            ],
            "bare": true,
            "figures": [
              {
                "src": "/guide/figures/scene/shanghai-exit-ne-1.jpg",
                "caption": "↑ 东北、东南出口"
              },
              {
                "src": "/guide/figures/scene/shanghai-exit-ne-2.jpg",
                "caption": "↑ 东北、东南出口"
              },
              {
                "src": "/guide/figures/scene/shanghai-exit-sw.jpg",
                "caption": "↑ 西北、西南出口"
              }
            ]
          }
        ]
      }
    },
    {
      "id": "shanghai-south",
      "name": "铁路上海南站",
      "note": null,
      "color": "#3f6ea8",
      "order": 3,
      "guideFigures": [],
      "guideVideos": [],
      "remark": "",
      "sceneGuide": {
        "sections": [
          {
            "title": "从上海南站去往南广场公交枢纽（上嘉线）：",
            "campuses": ["jiading"],
            "steps": [
              {
                "text": "进入地下区域",
                "figure": "/guide/figures/scene/south-1.jpg"
              },
              {
                "text": "向南广场公交枢纽（郊），不要去（市）",
                "figure": "/guide/figures/scene/south-2.jpg"
              },
              {
                "text": "继续沿指示牌走",
                "figure": "/guide/figures/scene/south-3.jpg"
              },
              {
                "text": "进入地下通道，前往南广场公交枢纽方向",
                "figure": "/guide/figures/scene/south-4.jpg"
              },
              {
                "text": "继续向前",
                "figure": "/guide/figures/scene/south-5.jpg"
              },
              {
                "text": "到达上嘉线站厅，前往站台",
                "figure": [
                  "/guide/figures/scene/south-6a.jpg",
                  "/guide/figures/scene/south-6b.jpg"
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "id": "pudong-airport",
      "name": "浦东机场",
      "note": null,
      "color": "#8cc63e",
      "order": 4,
      "guideFigures": [],
      "guideVideos": [],
      "remark": "",
      "sceneGuide": {
        "sections": [
          {
            "title": "从航站楼去往地铁 / 磁浮 / 市域机场线：",
            "steps": [
              {
                "text": "机场（T1/T2 航站楼）到达后，根据指示牌往联络通道走",
                "note": "（推荐前往中间的联络通道）",
                "figure": "/guide/figures/scene/pudong-1.jpg"
              },
              {
                "text": "到达联络通道后，继续往里",
                "figure": "/guide/figures/scene/pudong-2.jpg"
              },
              {
                "text": "在中间位置即可看到地铁2号线/磁浮线/市域机场线的车站入口",
                "figure": [
                  "/guide/figures/scene/pudong-3a.jpg",
                  "/guide/figures/scene/pudong-3b.jpg"
                ]
              }
            ]
          },
          {
            "title": "市域机场线车站出入口",
            "bare": true,
            "steps": [
              {
                "text": "车站共有 6 个出入口",
                "figure": "/guide/figures/scene/pudong-gate.jpg"
              },
              {
                "text": "其中 1~3 号口只有垂直电梯"
              },
              {
                "text": "4~6 号口只有扶手电梯"
              },
              {
                "text": "行李较多的同学, 推荐前往 1-3 号口（中间通道）"
              }
            ]
          }
        ]
      }
    },
    {
      "id": "songjiang",
      "name": "铁路上海松江站",
      "note": null,
      "color": "#e8a08c",
      "order": 5,
      "guideFigures": [],
      "guideVideos": [],
      "remark": ""
    },
    {
      "id": "appendix",
      "name": "附录1",
      "note": "（上海松江站换乘指南）",
      "color": "#9aa2ac",
      "order": 6,
      "guideFigures": [],
      "guideVideos": [],
      "remark": "",
      "sceneGuide": {
        "intro": "松江枢纽离我校较远，我们建议采用“铁路中转”，前往市内更加接近我校的铁路客站以节约时间。推荐去往宝山校区、延长校区的同学前往上海南站中转；去往嘉定校区的同学前往上海虹桥站中转。",
        "sections": [
          {
            "title": "第一步　确定下车位置",
            "bare": true,
            "steps": [
              {
                "text": "铁路上海松江站分南、北两区，其中 1、2 站台位于南区，3-10 站台位于北区。"
              },
              {
                "text": "购买第一程车票前往上海松江站的 SHUer 需要提前判断出自己所乘坐的列车将会停靠在哪个区域，以便后续在该站中转。"
              }
            ]
          },
          {
            "title": "第二步　查询中转选择",
            "bare": true,
            "steps": [
              {
                "text": "北区检票口为 1A/B–10A/B，南区检票口为 1-2。"
              },
              {
                "text": "用颜色区分终点：绿色车次可前往上海虹桥，橙色车次可前往上海南站，黑色车次可前往上海站。"
              },
              {
                "text": "图例读法：左侧「时 分」为从上海松江站开出的时刻，右侧为车次与到达目的地时间。"
              }
            ]
          }
        ],
        "pending": {
          "label": "车次号表待录入",
          "detail": "约 60 个 D/G 字头车次及其时刻正在核对补录中，出行前请以车站公告与 12306 信息为准。"
        }
      }
    }
  ],
  "cards": [
    {
      "id": "hq-bs-metro-a",
      "kind": "route",
      "origin": {
        "name": "虹桥枢纽",
        "note": "（铁路上海虹桥站 虹桥机场）"
      },
      "hub": "hongqiao",
      "campus": "baoshan",
      "toward": "去往 宝山校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 75,
      "fareYuan": 6,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "虹桥火车站/虹桥2号航站楼",
          "marker": "dot",
          "rails": [
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往浦东1号2号航站楼方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "静安寺",
          "marker": "transfer",
          "rails": [
            "l7"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l7"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "7",
              "color": "l7",
              "suffix": "号线",
              "toward": "往美兰湖/祁华路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海大学",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "hq-bs-metro-b",
      "kind": "route",
      "origin": {
        "name": "虹桥枢纽",
        "note": "（虹桥1号航站楼出发）"
      },
      "hub": "hongqiao",
      "campus": "baoshan",
      "toward": "去往 宝山校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 90,
      "fareYuan": 5,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "虹桥1号航站楼",
          "marker": "dot",
          "rails": [
            "l10"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l10"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "10",
              "color": "l10",
              "suffix": "号线",
              "toward": "往虹桥火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "虹桥火车站",
          "marker": "transfer",
          "rails": [
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往浦东1号2号航站楼方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "静安寺",
          "marker": "transfer",
          "rails": [
            "l7"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l7"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "7",
              "color": "l7",
              "suffix": "号线",
              "toward": "往美兰湖/祁华路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海大学",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "hq-jd-metro",
      "kind": "route",
      "origin": {
        "name": "虹桥枢纽",
        "note": "（铁路上海虹桥站 虹桥机场）"
      },
      "hub": "hongqiao",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 75,
      "fareYuan": 8,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "虹桥火车站",
          "marker": "transfer",
          "rails": [
            "l10",
            "l2"
          ]
        },
        {
          "type": "stop",
          "name": "虹桥2号航站楼",
          "marker": "transfer",
          "rails": [
            "l10",
            "l2"
          ]
        },
        {
          "type": "stop",
          "name": "虹桥1号航站楼",
          "marker": "dot",
          "rails": [
            "l10",
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l10",
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "10",
              "color": "l10",
              "suffix": "号线",
              "toward": "往基隆路方向"
            },
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往浦东1号2号航站楼方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "交通大学",
          "marker": "dot",
          "rails": [
            "l10",
            "l2"
          ]
        },
        {
          "type": "stop",
          "name": "江苏路",
          "marker": "dot",
          "rails": [
            "l10",
            "l2"
          ],
          "mergeTo": [
            "l11"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l11"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "11",
              "color": "l11",
              "suffix": "号线",
              "toward": "往嘉定北方向",
              "note": "不要乘坐往花桥方向的列车"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定北",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "平城路城北路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定13路",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "城中路塔城路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 385,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "hq-jd-bus-east",
      "kind": "route",
      "origin": {
        "name": "虹桥枢纽",
        "note": "（东交通中心出发）"
      },
      "hub": "hongqiao",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "bus",
      "modeLabel": "公交",
      "durationMin": 65,
      "fareYuan": 11,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "虹桥枢纽东交通中心",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "虹桥枢纽9路",
              "color": "bus",
              "toward": "往 嘉定客运中心方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定客运中心",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 530,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定西站",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定5路",
              "color": "bus",
              "toward": "往 新城路车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "塔城路梅园路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 57,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "hq-jd-bus-west",
      "kind": "route",
      "origin": {
        "name": "虹桥枢纽",
        "note": "（西交通中心出发）"
      },
      "hub": "hongqiao",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "bus",
      "modeLabel": "公交",
      "durationMin": 50,
      "fareYuan": 8,
      "flags": [
        "需提前购票",
        "每日 4 班"
      ],
      "legs": [
        {
          "type": "stop",
          "name": "虹桥枢纽西交通中心",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉虹1路",
              "color": "bus",
              "toward": "往 南门公交站方向",
              "notes": [
                "请在 “嘉定客运中心” 公众号提前购票"
              ]
            }
          ]
        },
        {
          "type": "stop",
          "name": "南门公交站",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 450,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": [
        {
          "label": "嘉虹1路 发车时刻",
          "times": "08:30  11:00  18:15  20:30"
        }
      ]
    },
    {
      "id": "hq-jd-fig-route",
      "kind": "figure",
      "hub": "hongqiao",
      "campus": "jiading",
      "figure": "route-hongqiao-jiading",
      "title": "示意图",
      "caption": "三条方案的实际走向。",
      "hotspots": [
        {
          "id": "h-jdb",
          "x": 29,
          "y": 13,
          "w": 78,
          "h": 42,
          "title": "嘉定北站",
          "body": "11 号线往嘉定北方向的终点段。出站请走 2 号口，站外换乘嘉定 13 路。",
          "links": [
            {
              "label": "在 SHUMap 中查看嘉定校区",
              "href": "#shumap:jiading"
            },
            {
              "label": "高德地图导航到嘉定北站",
              "href": "https://uri.amap.com/marker?name=%E5%98%89%E5%AE%9A%E5%8C%97%E7%AB%99"
            }
          ]
        },
        {
          "id": "h-nmgj",
          "x": 40,
          "y": 24,
          "w": 132,
          "h": 42,
          "title": "南门公交站",
          "body": "嘉虹 1 路与嘉定 13 路的共同落客点，步行 450 米可到嘉定校区东门。",
          "links": [
            {
              "label": "查看嘉虹 1 路发车时刻",
              "href": "#card:hq-jd-bus-west"
            }
          ]
        },
        {
          "id": "h-jdkyzx",
          "x": 6.5,
          "y": 39,
          "w": 44,
          "h": 156,
          "title": "嘉定客运中心",
          "body": "虹桥枢纽 9 路的终点站。下车后步行 530 米换乘嘉定 5 路。",
          "links": [
            {
              "label": "查看该方案完整路线",
              "href": "#card:hq-jd-bus-east"
            }
          ]
        },
        {
          "id": "h-jsl",
          "x": 81,
          "y": 68.5,
          "w": 92,
          "h": 40,
          "title": "江苏路站",
          "body": "10 号线 / 2 号线换乘 11 号线的关键站。11 号线在此分岔，务必确认列车终点为嘉定北。",
          "links": [
            {
              "label": "查看 11 号线运营信息",
              "href": "https://www.shmetro.com"
            }
          ]
        },
        {
          "id": "h-hq",
          "x": 26,
          "y": 92,
          "w": 112,
          "h": 38,
          "title": "虹桥枢纽",
          "body": "铁路上海虹桥站、虹桥机场 T1／T2 共用枢纽。地铁在 B2 层，长途与公交在东、西交通中心。",
          "links": [
            {
              "label": "查看枢纽内部图",
              "href": "#card:hq-jd-fig-hub"
            }
          ]
        },
        {
          "id": "h-jtdx",
          "x": 66,
          "y": 90,
          "w": 112,
          "h": 38,
          "title": "交通大学站",
          "body": "10 号线沿线站点，可作为市区中转参考。",
          "links": []
        }
      ]
    },
    {
      "id": "hq-jd-fig-hub",
      "kind": "figure",
      "hub": "hongqiao",
      "campus": "jiading",
      "figure": "hub-hongqiao",
      "title": "虹桥枢纽图",
      "caption": "两个乘车点分居东西两侧，出站前先确认走哪一头。",
      "hotspots": [
        {
          "id": "h-bus9",
          "x": 28,
          "y": 20,
          "w": 260,
          "h": 70,
          "title": "虹桥枢纽 9 路乘车点",
          "body": "位于东侧交通枢纽 2 层。出铁路到达层后跟随“公交”指示牌步行约 6 分钟，终点为嘉定客运中心。",
          "links": [
            {
              "label": "查看该方案完整路线",
              "href": "#card:hq-jd-bus-east"
            }
          ]
        },
        {
          "id": "h-bus1",
          "x": 23,
          "y": 83,
          "w": 210,
          "h": 74,
          "title": "嘉虹 1 路乘车点",
          "body": "位于虹桥西交通中心 1 层。每日 4 班：08:30 / 11:00 / 18:15 / 20:30，需在“嘉定客运中心”公众号提前购票。",
          "links": [
            {
              "label": "关注嘉定客运中心公众号购票",
              "href": "#wechat:jdkyzx"
            }
          ]
        },
        {
          "id": "h-east",
          "x": 48,
          "y": 39,
          "w": 56,
          "h": 56,
          "title": "虹桥东交通中心",
          "body": "长途客运与市区公交集散点，虹桥枢纽 9 路在此发车。",
          "links": []
        },
        {
          "id": "h-west",
          "x": 7.4,
          "y": 56,
          "w": 52,
          "h": 52,
          "title": "虹桥西交通中心",
          "body": "嘉虹 1 路在此发车，靠近铁路站西侧出口。",
          "links": []
        },
        {
          "id": "h-rail",
          "x": 21,
          "y": 60,
          "w": 96,
          "h": 34,
          "title": "虹桥火车站（地铁站）",
          "body": "2 / 10 / 17 号线在此换乘。前往嘉定校区在此乘 10 号线或 2 号线。",
          "links": [
            {
              "label": "查看地铁方案",
              "href": "#card:hq-jd-metro"
            }
          ]
        },
        {
          "id": "h-t2",
          "x": 52,
          "y": 60,
          "w": 126,
          "h": 34,
          "title": "虹桥2号航站楼站",
          "body": "2 / 10 号线换乘站，机场到达可在此直接进站。",
          "links": []
        },
        {
          "id": "h-t1",
          "x": 79,
          "y": 59,
          "w": 130,
          "h": 34,
          "title": "虹桥1号航站楼站",
          "body": "仅 10 号线经停。T1 到达的同学在此乘车。",
          "links": []
        }
      ]
    },
    {
      "id": "hq-yc-metro-a",
      "kind": "route",
      "origin": {
        "name": "虹桥枢纽",
        "note": "（铁路上海虹桥站 虹桥机场）"
      },
      "hub": "hongqiao",
      "campus": "yanchang",
      "toward": "去往 延长校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 61,
      "fareYuan": 5,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "虹桥2号航站楼 / 虹桥火车站",
          "marker": "dot",
          "rails": [
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往浦东1号2号航站楼方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "人民广场",
          "marker": "transfer",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路/上海火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "延长路",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 400,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "延长校区南门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "hq-yc-metro-b",
      "kind": "route",
      "origin": {
        "name": "虹桥枢纽",
        "note": "（虹桥1号航站楼出发）"
      },
      "hub": "hongqiao",
      "campus": "yanchang",
      "toward": "去往 延长校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 61,
      "fareYuan": 5,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "虹桥1号航站楼",
          "marker": "dot",
          "rails": [
            "l10"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l10"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "10",
              "color": "l10",
              "suffix": "号线",
              "toward": "往基隆路/新江湾城方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "陕西南路",
          "marker": "transfer",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路/上海火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "延长路",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 400,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "延长校区南门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "sh-bs-metro",
      "kind": "route",
      "origin": {
        "name": "铁路上海站",
        "note": "（上海长途客运总站）"
      },
      "hub": "shanghai-railway",
      "campus": "baoshan",
      "toward": "去往 宝山校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 50,
      "fareYuan": 4,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海火车站",
          "marker": "dot",
          "rails": [
            "l3",
            "l4"
          ],
          "note": "下列两线列车均可乘坐"
        },
        {
          "type": "ride",
          "rails": [
            "l3",
            "l4"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "3",
              "color": "l3",
              "suffix": "号线",
              "toward": "往江杨北路方向"
            },
            {
              "kind": "metro",
              "no": "4",
              "color": "l4",
              "suffix": "号线",
              "toward": "往中山公园 上海体育场方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "镇坪路",
          "marker": "transfer",
          "rails": [
            "l7"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l7"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "7",
              "color": "l7",
              "suffix": "号线",
              "toward": "往美兰湖/祁华路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海大学",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "sh-bs-bus",
      "kind": "route",
      "origin": {
        "name": "铁路上海站",
        "note": "（西南出站口出发）"
      },
      "hub": "shanghai-railway",
      "campus": "baoshan",
      "toward": "去往 宝山校区",
      "mode": "bus",
      "modeLabel": "公交",
      "durationMin": 70,
      "fareYuan": 2,
      "flags": [
        "东南、西南口可免安检乘地铁1号线"
      ],
      "legs": [
        {
          "type": "stop",
          "name": "铁路上海站西南出站口",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 445,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "恒丰路天目西路（上海火车站）",
          "marker": "dot",
          "rails": [
            "bus185"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus185"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "185路",
              "color": "bus185",
              "toward": "往 园康路市台路"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上大路文海路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 325,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区南门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "sh-jd-bus",
      "kind": "route",
      "origin": {
        "name": "铁路上海站",
        "note": "（南广场出发）"
      },
      "hub": "shanghai-railway",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "bus",
      "modeLabel": "公交",
      "durationMin": 60,
      "fareYuan": 8,
      "flags": [
        "每日 20 班"
      ],
      "legs": [
        {
          "type": "stop",
          "name": "上海站南广场",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 270,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "恒丰路秣陵路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "沪嘉专线",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "南门公交站",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 470,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": [
        {
          "label": "沪嘉专线 发车时刻",
          "times": "05:40  06:30  07:10  08:00  09:00  09:40  10:10\n10:40  11:30  12:30  13:30  14:30  15:40  16:50\n17:40  18:20  19:10  20:00  20:50  21:30"
        }
      ]
    },
    {
      "id": "sh-jd-metro",
      "kind": "route",
      "origin": {
        "name": "铁路上海站",
        "note": "（上海长途客运总站）"
      },
      "hub": "shanghai-railway",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 75,
      "fareYuan": 8,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海火车站",
          "marker": "dot",
          "rails": [
            "l3",
            "l4"
          ],
          "note": "下列两线列车均可乘坐"
        },
        {
          "type": "ride",
          "rails": [
            "l3",
            "l4"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "3",
              "color": "l3",
              "suffix": "号线",
              "toward": "往江杨北路方向"
            },
            {
              "kind": "metro",
              "no": "4",
              "color": "l4",
              "suffix": "号线",
              "toward": "往中山公园 上海体育场方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "曹杨路",
          "marker": "transfer",
          "rails": [
            "l11"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l11"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "11",
              "color": "l11",
              "suffix": "号线",
              "toward": "往嘉定北方向",
              "note": "不要乘坐往花桥方向的列车"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定北",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "平城路城北路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定13路",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "城中路塔城路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 385,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "sh-yc-metro",
      "kind": "route",
      "origin": {
        "name": "铁路上海站",
        "note": "（上海长途客运总站）"
      },
      "hub": "shanghai-railway",
      "campus": "yanchang",
      "toward": "去往 延长校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 17,
      "fareYuan": 3,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海火车站",
          "marker": "dot",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路/上海火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "延长路",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 400,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "延长校区南门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "ss-bs-metro-a",
      "kind": "route",
      "origin": {
        "name": "铁路上海南站",
        "note": null
      },
      "hub": "shanghai-south",
      "campus": "baoshan",
      "toward": "去往 宝山校区",
      "mode": "metro",
      "modeLabel": "方案1",
      "durationMin": 50,
      "fareYuan": 5,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海南站",
          "marker": "dot",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路/上海火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "常熟路",
          "marker": "transfer",
          "rails": [
            "l7"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l7"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "7",
              "color": "l7",
              "suffix": "号线",
              "toward": "往美兰湖/祁华路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海大学",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "ss-bs-metro-b",
      "kind": "route",
      "origin": {
        "name": "铁路上海南站",
        "note": null
      },
      "hub": "shanghai-south",
      "campus": "baoshan",
      "toward": "去往 宝山校区",
      "mode": "metro",
      "modeLabel": "方案2",
      "durationMin": 56,
      "fareYuan": 5,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海南站",
          "marker": "dot",
          "rails": [
            "l3"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l3"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "3",
              "color": "l3",
              "suffix": "号线",
              "toward": "往江杨北路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "镇坪路",
          "marker": "transfer",
          "rails": [
            "l7"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l7"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "7",
              "color": "l7",
              "suffix": "号线",
              "toward": "往美兰湖/祁华路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海大学",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "ss-jd-metro-a",
      "kind": "route",
      "origin": {
        "name": "铁路上海南站",
        "note": null
      },
      "hub": "shanghai-south",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 95,
      "fareYuan": 7,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海南站",
          "marker": "dot",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "徐家汇",
          "marker": "transfer",
          "rails": [
            "l11"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l11"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "11",
              "color": "l11",
              "suffix": "号线",
              "toward": "往嘉定北方向",
              "note": "不要乘坐往花桥方向的列车"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定北",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "平城路城北路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定13路",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "城中路塔城路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 385,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "ss-jd-metro-b",
      "kind": "route",
      "origin": {
        "name": "铁路上海南站",
        "note": "（经上海西站换乘）"
      },
      "hub": "shanghai-south",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 90,
      "fareYuan": 7,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海南站",
          "marker": "dot",
          "rails": [
            "l15"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l15"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "15",
              "color": "l15",
              "suffix": "号线",
              "toward": "往顾村公园方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海西站",
          "marker": "transfer",
          "rails": [
            "l11"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l11"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "11",
              "color": "l11",
              "suffix": "号线",
              "toward": "往嘉定北方向",
              "note": "不要乘坐往花桥方向的列车"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定北",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "平城路城北路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定13路",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "城中路塔城路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 385,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "ss-jd-bus",
      "kind": "route",
      "origin": {
        "name": "铁路上海南站",
        "note": "（南广场市郊公交出发）"
      },
      "hub": "shanghai-south",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "bus",
      "modeLabel": "公交",
      "durationMin": 110,
      "fareYuan": 12,
      "flags": [
        "每日 19 班"
      ],
      "legs": [
        {
          "type": "stop",
          "name": "上海南站出站口",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "note": "进入南站地下通道, 前往市郊公交站台"
        },
        {
          "type": "walk",
          "meters": 500,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "上海南站（南广场）",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "上嘉线",
              "color": "bus",
              "toward": "往 嘉定客运中心方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "永盛路福海路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定5路",
              "color": "bus",
              "toward": "往 新城路车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "塔城路梅园路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 57,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": [
        {
          "label": "上嘉线 发车时刻",
          "times": "06:00  06:40  07:20  08:10  09:00  09:50\n10:40  11:30  12:20  13:00  13:40  14:20\n15:10  16:50  17:40  18:40  19:20  20:10\n21:00"
        }
      ]
    },
    {
      "id": "ss-yc-metro",
      "kind": "route",
      "origin": {
        "name": "铁路上海南站",
        "note": null
      },
      "hub": "shanghai-south",
      "campus": "yanchang",
      "toward": "去往 延长校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 43,
      "fareYuan": 4,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海南站",
          "marker": "dot",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路/上海火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "延长路",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 400,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "延长校区南门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "pd-bs-metro",
      "kind": "route",
      "origin": {
        "name": "浦东机场",
        "note": null
      },
      "hub": "pudong-airport",
      "campus": "baoshan",
      "toward": "去往 宝山校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 125,
      "fareYuan": 8,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "浦东1号2号航站楼",
          "marker": "dot",
          "rails": [
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往国家会展中心方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "静安寺",
          "marker": "transfer",
          "rails": [
            "l7"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l7"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "7",
              "color": "l7",
              "suffix": "号线",
              "toward": "往美兰湖/祁华路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海大学",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "pd-jd-maglev",
      "kind": "route",
      "origin": {
        "name": "浦东机场",
        "note": "（磁浮线出发）"
      },
      "hub": "pudong-airport",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "maglev",
      "modeLabel": "磁浮",
      "durationMin": 115,
      "fareYuan": 49,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "浦东1号2号航站楼",
          "marker": "dot",
          "rails": [
            "maglev"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "maglev"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "磁浮线",
              "color": "maglev",
              "toward": "往龙阳路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "龙阳路",
          "marker": "transfer",
          "rails": [
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往国家会展中心方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "江苏路",
          "marker": "transfer",
          "rails": [
            "l11"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l11"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "11",
              "color": "l11",
              "suffix": "号线",
              "toward": "往嘉定北方向",
              "note": "不要乘坐往花桥方向的列车"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定北",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "平城路城北路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定13路",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "城中路塔城路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 385,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "pd-jd-airport",
      "kind": "route",
      "origin": {
        "name": "浦东机场",
        "note": "（市域机场线出发）"
      },
      "hub": "pudong-airport",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "airport",
      "modeLabel": "市域线",
      "durationMin": 120,
      "fareYuan": 36,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "浦东1号2号航站楼",
          "marker": "dot",
          "rails": [
            "airport"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "airport"
          ],
          "lines": [
            {
              "kind": "plain",
              "no": "市域机场线",
              "color": "airport",
              "toward": "往虹桥2号航站楼方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "虹桥2号航站楼",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 200,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "虹桥枢纽东交通中心",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "虹桥枢纽9路",
              "color": "bus",
              "toward": "往 嘉定客运中心方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定客运中心",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 530,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定西站",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定5路",
              "color": "bus",
              "toward": "往 新城路车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "塔城路梅园路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 57,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "pd-jd-metro",
      "kind": "route",
      "origin": {
        "name": "浦东机场",
        "note": null
      },
      "hub": "pudong-airport",
      "campus": "jiading",
      "toward": "去往 嘉定校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 151,
      "fareYuan": 12,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "浦东1号2号航站楼",
          "marker": "dot",
          "rails": [
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往国家会展中心方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "江苏路",
          "marker": "transfer",
          "rails": [
            "l11"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l11"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "11",
              "color": "l11",
              "suffix": "号线",
              "toward": "往嘉定北方向",
              "note": "不要乘坐往花桥方向的列车"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定北",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "平城路城北路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定13路",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "城中路塔城路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 385,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "pd-yc-metro",
      "kind": "route",
      "origin": {
        "name": "浦东机场",
        "note": null
      },
      "hub": "pudong-airport",
      "campus": "yanchang",
      "toward": "去往 延长校区",
      "mode": "metro",
      "modeLabel": "地铁",
      "durationMin": 94,
      "fareYuan": 7,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "浦东1号2号航站楼",
          "marker": "dot",
          "rails": [
            "l2"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l2"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "2",
              "color": "l2",
              "suffix": "号线",
              "toward": "往国家会展中心方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "人民广场",
          "marker": "transfer",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路/上海火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "延长路",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 400,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "延长校区南门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "sj-bs-metro",
      "kind": "route",
      "origin": {
        "name": "松江枢纽",
        "note": "（铁路上海松江站）"
      },
      "hub": "songjiang",
      "campus": "all",
      "toward": "去往 宝山校区",
      "mode": "metro",
      "modeLabel": "宝山",
      "durationMin": 110,
      "fareYuan": 8,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海松江站",
          "marker": "dot",
          "rails": [
            "l9"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l9"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "9",
              "color": "l9",
              "suffix": "号线",
              "toward": "往曹路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "肇嘉浜路",
          "marker": "transfer",
          "rails": [
            "l7"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l7"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "7",
              "color": "l7",
              "suffix": "号线",
              "toward": "往美兰湖/祁华路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "上海大学",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "宝山校区北门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "sj-jd-metro",
      "kind": "route",
      "origin": {
        "name": "松江枢纽",
        "note": "（铁路上海松江站）"
      },
      "hub": "songjiang",
      "campus": "all",
      "toward": "去往 嘉定校区",
      "mode": "metro",
      "modeLabel": "嘉定",
      "durationMin": 145,
      "fareYuan": 12,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海松江站",
          "marker": "dot",
          "rails": [
            "l9"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l9"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "9",
              "color": "l9",
              "suffix": "号线",
              "toward": "往曹路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "徐家汇",
          "marker": "transfer",
          "rails": [
            "l11"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l11"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "11",
              "color": "l11",
              "suffix": "号线",
              "toward": "往嘉定北方向",
              "note": "不要乘坐往花桥方向的列车"
            }
          ]
        },
        {
          "type": "stop",
          "name": "嘉定北",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 45,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "平城路城北路",
          "marker": "dot",
          "rails": [
            "bus"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "bus"
          ],
          "lines": [
            {
              "kind": "bus",
              "no": "嘉定13路",
              "color": "bus",
              "toward": "往 南门公交站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "城中路塔城路",
          "marker": "dot",
          "rails": [
            "walk"
          ]
        },
        {
          "type": "walk",
          "meters": 385,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "嘉定校区东门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    },
    {
      "id": "sj-yc-metro",
      "kind": "route",
      "origin": {
        "name": "松江枢纽",
        "note": "（铁路上海松江站）"
      },
      "hub": "songjiang",
      "campus": "all",
      "toward": "去往 延长校区",
      "mode": "metro",
      "modeLabel": "延长",
      "durationMin": 105,
      "fareYuan": 8,
      "flags": [],
      "legs": [
        {
          "type": "stop",
          "name": "上海松江站",
          "marker": "dot",
          "rails": [
            "l9"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l9"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "9",
              "color": "l9",
              "suffix": "号线",
              "toward": "往曹路方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "徐家汇",
          "marker": "transfer",
          "rails": [
            "l1"
          ]
        },
        {
          "type": "ride",
          "rails": [
            "l1"
          ],
          "lines": [
            {
              "kind": "metro",
              "no": "1",
              "color": "l1",
              "suffix": "号线",
              "toward": "往富锦路/上海火车站方向"
            }
          ]
        },
        {
          "type": "stop",
          "name": "延长路",
          "marker": "dot",
          "rails": [
            "walk"
          ],
          "exit": "（2号口出站）"
        },
        {
          "type": "walk",
          "meters": 400,
          "rails": [
            "walk"
          ]
        },
        {
          "type": "stop",
          "name": "延长校区西门",
          "marker": "dot",
          "terminal": true
        }
      ],
      "note": "",
      "schedule": []
    }
  ]
};
