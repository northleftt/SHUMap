// 数据文件（.ts 模块 export default，小程序编译器不打包 .json，见 miniprogram/AGENTS.md 坑 #2）
// 由 scripts/generate_miniprogram_shuttle_snapshot.mjs 生成，请勿手改。
// 0024 校区对校区改版结构：pairs 的键是「fromEndpointId>toEndpointId」，值是 lines[]
// （线路级预约；快照无站点粒度，上下车点以线上 campus-lines 接口为准）。
export default {
  "version": "Ver2025.11",
  "endpoints": [
    {
      "id": "campus_baoshan",
      "name": "宝山校区"
    },
    {
      "id": "campus_jiading",
      "name": "嘉定校区"
    },
    {
      "id": "campus_yanchang",
      "name": "延长校区"
    },
    {
      "id": "stop:stop_陈太公寓",
      "name": "陈太公寓"
    }
  ],
  "pairs": {
    "campus_baoshan>campus_yanchang": [
      {
        "routeName": "宝山校区 → 延长校区",
        "bookingPolicy": "not_required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:00",
            "09:30",
            "10:30",
            "11:30",
            "12:30",
            "13:30",
            "14:30",
            "15:30",
            "17:00",
            "18:00",
            "22:00"
          ],
          "weekend": [
            "08:30",
            "17:00"
          ],
          "holiday": [
            "08:30",
            "17:00"
          ],
          "winterBreak": [
            "08:30",
            "17:00"
          ],
          "summerBreak": [
            "07:45",
            "11:30",
            "16:30"
          ]
        }
      },
      {
        "routeName": "宝山校区 → 延长校区（预约）",
        "bookingPolicy": "required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "12:00",
            "17:00",
            "21:30"
          ],
          "weekend": [],
          "holiday": [],
          "winterBreak": [],
          "summerBreak": []
        }
      }
    ],
    "campus_yanchang>campus_baoshan": [
      {
        "routeName": "延长校区 → 宝山校区",
        "bookingPolicy": "not_required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:00",
            "09:00",
            "10:00",
            "11:00",
            "12:00",
            "13:00",
            "14:00",
            "15:00",
            "17:00"
          ],
          "weekend": [
            "07:30",
            "16:00"
          ],
          "holiday": [
            "07:30",
            "16:00"
          ],
          "winterBreak": [
            "07:30",
            "16:00"
          ],
          "summerBreak": [
            "07:15",
            "11:00",
            "16:00"
          ]
        }
      },
      {
        "routeName": "延长校区 → 宝山校区（预约）",
        "bookingPolicy": "required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:10",
            "09:00",
            "12:00"
          ],
          "weekend": [],
          "holiday": [],
          "winterBreak": [],
          "summerBreak": []
        }
      }
    ],
    "campus_baoshan>campus_jiading": [
      {
        "routeName": "宝山校区 → 嘉定校区",
        "bookingPolicy": "not_required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:00",
            "08:00",
            "09:30",
            "10:30",
            "11:30",
            "12:30",
            "13:30",
            "14:30",
            "15:30",
            "17:00",
            "18:00",
            "21:00",
            "22:00"
          ],
          "weekend": [
            "08:30",
            "17:00"
          ],
          "holiday": [
            "08:30",
            "17:00"
          ],
          "winterBreak": [
            "08:30",
            "17:00"
          ],
          "summerBreak": [
            "07:45",
            "11:30",
            "16:30"
          ]
        }
      },
      {
        "routeName": "宝山校区 → 嘉定校区（预约）",
        "bookingPolicy": "required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "12:00",
            "13:30",
            "16:30",
            "17:30",
            "20:00",
            "21:00",
            "22:00"
          ],
          "weekend": [],
          "holiday": [],
          "winterBreak": [],
          "summerBreak": []
        }
      }
    ],
    "campus_jiading>campus_baoshan": [
      {
        "routeName": "嘉定校区 → 宝山校区",
        "bookingPolicy": "not_required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:00",
            "09:00",
            "10:00",
            "11:00",
            "12:00",
            "13:00",
            "14:00",
            "15:00",
            "17:00",
            "21:00",
            "22:00"
          ],
          "weekend": [
            "07:30",
            "16:00"
          ],
          "holiday": [
            "07:30",
            "16:00"
          ],
          "winterBreak": [
            "07:30",
            "16:00"
          ],
          "summerBreak": [
            "07:15",
            "11:00",
            "16:00"
          ]
        }
      },
      {
        "routeName": "嘉定校区 → 宝山校区（预约）",
        "bookingPolicy": "required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:00",
            "08:00",
            "09:00",
            "12:00",
            "14:00",
            "17:00"
          ],
          "weekend": [],
          "holiday": [],
          "winterBreak": [],
          "summerBreak": []
        }
      }
    ],
    "campus_baoshan>stop:stop_陈太公寓": [
      {
        "routeName": "宝山校区 → 陈太公寓",
        "bookingPolicy": "required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "11:45",
            "14:45",
            "17:45",
            "20:45",
            "21:45"
          ],
          "weekend": [],
          "holiday": [
            "12:45",
            "18:45"
          ],
          "winterBreak": [],
          "summerBreak": []
        }
      }
    ],
    "stop:stop_陈太公寓>campus_baoshan": [
      {
        "routeName": "陈太公寓 → 宝山校区",
        "bookingPolicy": "required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:15",
            "09:15",
            "11:15",
            "14:15",
            "17:15"
          ],
          "weekend": [],
          "holiday": [
            "08:15",
            "11:15",
            "17:15"
          ],
          "winterBreak": [],
          "summerBreak": []
        }
      }
    ],
    "campus_jiading>campus_yanchang": [
      {
        "routeName": "嘉定校区 → 延长校区",
        "bookingPolicy": "not_required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:00",
            "09:00",
            "10:00",
            "11:00",
            "12:00",
            "13:00",
            "14:00",
            "15:00",
            "17:00",
            "18:00",
            "21:00"
          ],
          "weekend": [
            "07:30",
            "16:00"
          ],
          "holiday": [
            "07:30",
            "16:00"
          ],
          "winterBreak": [
            "07:30",
            "16:00"
          ],
          "summerBreak": [
            "07:15",
            "11:00",
            "16:00"
          ]
        }
      },
      {
        "routeName": "嘉定校区 → 延长校区（预约）",
        "bookingPolicy": "required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "08:00"
          ],
          "weekend": [],
          "holiday": [],
          "winterBreak": [],
          "summerBreak": []
        }
      }
    ],
    "campus_yanchang>campus_jiading": [
      {
        "routeName": "延长校区 → 嘉定校区",
        "bookingPolicy": "not_required",
        "bookingUrl": null,
        "schedules": {
          "weekday": [
            "07:00",
            "09:00",
            "10:00",
            "11:00",
            "12:00",
            "13:00",
            "14:00",
            "15:00",
            "17:00",
            "22:00"
          ],
          "weekend": [
            "08:30",
            "17:00"
          ],
          "holiday": [
            "08:30",
            "17:00"
          ],
          "winterBreak": [
            "08:30",
            "17:00"
          ],
          "summerBreak": [
            "07:15",
            "11:00",
            "16:00"
          ]
        }
      }
    ]
  }
} as const;
