-- 0023_transit_travel_time_samples.sql — 校车区间用时采样
--
-- 为什么要这张表：时刻表只有发车时刻，「几点能到」在页面上一直是空的。
-- 原始 PDF（data/shuttle-schedule.json）全是 departureTime；后台保存班次时
-- arrival_time 和 departure_time 写的是同一个值（src/admin/pages/TransitPage.tsx
-- 的 stopTimes 构造），所以 transit_stop_times 里到达列即使非空也不是真的到达时间。
--
-- 校车按表发车（到点就走），所以到达时间里唯一的未知量是行驶耗时。腾讯距离矩阵
-- 接口（apis.map.qq.com/ws/distance/v1/matrix）的 departure_time 支持传未来出发
-- 时刻，返回的是那个时刻的预测路况耗时 —— 不必先攒几周历史才能起步。
--
-- 实测（宝山→延长，同一对坐标，连测两轮）：03:00 出发 19.7min / 08:00 出发
-- 24.2min，跨时段极差 4.5min，轮间噪声 0.5min。信号比噪声大一个量级。
--
-- 为什么按 (pattern, 区间, 发车时刻) 存而不是按 trip 存：多个 trip 共用同一个
-- pattern 和同一个发车时刻（差别只在服务日历），而预测只跟「走哪一段、几点走」
-- 有关。按 trip 存会把同一个预测复制很多份，还得在班次改动时一起维护。
--
-- 为什么 append-only 而不是一行一个当前值：
--   * 单次 API 抖动不该直接变成页面上的数字，读侧取中位数（medianDurationSeconds）；
--   * 「这条线每天开多久」的分布本身是后面要展示的东西（用时曲线）；
--   * 众包校正要拿用户报的实际到达时间跟当时的预测值比，得留得住历史。
--
-- 区间只存**相邻**停靠对（to_stop_sequence 是 from 的下一站，见 travel-time.ts
-- 的 loadSegments）。多站线路的任意两站用时是相邻区间的累加，不必再采一遍；
-- 现有 8 条线都是点对点，相邻对就是全程。

pragma foreign_keys = on;

create table transit_travel_time_samples (
  id text primary key,
  pattern_id text not null references transit_patterns(id) on delete cascade,
  from_stop_sequence integer not null check (from_stop_sequence >= 0),
  -- 表级 CHECK 可以跨列引用；区间必须是正向的，反向会让累加算出负的到达时间。
  to_stop_sequence integer not null check (to_stop_sequence > from_stop_sequence),
  -- 该区间起点站的排班发车时刻（HH:MM），也就是问 provider 的那个「几点出发」。
  departure_time text not null check (departure_time like '__:__'),
  -- 实际问的那个未来时刻（ISO）。provider 只接受未来 7 天内的时间戳，超出报
  -- status 348；留着它才能判断这条样本问的是哪个日型的哪一天。
  departure_at text not null,
  duration_seconds integer not null check (duration_seconds > 0 and duration_seconds < 86400),
  distance_meters integer check (distance_meters is null or distance_meters >= 0),
  -- 换 provider 要新增枚举值：matrix 与 direction 不是同一个引擎（前者返回秒、
  -- 后者返回分钟，且短线 matrix 系统性偏乐观约 20%），混在一起取中位数会串味。
  provider text not null default 'tencent_matrix' check (provider in ('tencent_matrix')),
  sampled_at text not null
);

-- 读路径：按区间 + 发车时刻取最近 N 条求中位数，所以 sampled_at 倒序进索引。
create index idx_travel_time_segment on transit_travel_time_samples(
  pattern_id, from_stop_sequence, to_stop_sequence, departure_time, sampled_at desc
);

-- 采样路径：挑「最久没采过」的区间优先（selectStaleSegments），以及保留期清理。
create index idx_travel_time_sampled on transit_travel_time_samples(sampled_at desc);
