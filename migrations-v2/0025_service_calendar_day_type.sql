-- 0025_service_calendar_day_type.sql — 日型上收到服务日历
--
-- 为什么要这个字段：客户端那句「今天是工作日 / 周末 / 假日 / 寒假 / 暑假」此前算在
-- 前端，数据源是 data/academic-calendar.json —— 2026-03-11 提交 1ee1733 手写的一份
-- 草稿，没有任何生成脚本、worker 侧零引用、假日只列到 2026-06-19。班次归属早就从
-- 这张表读了（publicCampusLines 按 service_calendars 过滤），只有这个标签还挂在那份
-- 草稿上，于是出现「页面说今天是假日，但假日班次一个都不出」这类不一致。
--
-- 根因是这张表存不下「这是哪种日型」：只有 name（自由文本）和七个星期标记。名字确实
-- 写着「2025-2026 工作日」，但靠解析名字判断日型是脆的（改个名就错，且拦不住
-- 「考试周」这类不属于任何日型的日历）。所以这里给出一个显式枚举，日型从此由管理端
-- 的日历管理直接决定。
--
-- 'other' 是默认值也是逃生舱：不属于五种日型的日历（临时加开、考试周）选它，
-- 客户端的日型标签不会认它，但班次照常运营。
--
-- 回填按现有五条日历的 id 后缀直接点名，不用 CASE：
-- scripts/validate_migration_applicability.mjs 记着 D1 远端 splitter 遇到 CASE 会
-- 在它自己的 END; 处截断（触发器体内致命）。这里虽然在触发器外，但逐条 UPDATE
-- 更直白，也不依赖那条限制的边界。
--
-- 不动 valid_from/valid_to：现有「工作日」日历的有效期覆盖了整个寒暑假，和
-- 「暑假」日历在 8 月重叠，同一天两个日历都命中导致班次叠加。那是运营数据问题
-- （要么收窄工作日日历的有效期，要么加 removed 例外日），得在管理端按实际校历决定，
-- 迁移不替人做这个决定。日型解析对重叠有确定的优先级（见 worker/modules/transit.ts
-- 的 resolveDayType），所以标签不会因此变得不确定。

pragma foreign_keys = on;

alter table service_calendars
  add column day_type text not null default 'other'
  check (day_type in ('weekday','weekend','holiday','winter_break','summer_break','other'));

-- 回填：seed 生成器（scripts/generate_v2_seed.mjs）按 `calendar_<学年>_<bucket>`
-- 命名，bucket 就是日型，所以按 id 后缀点名即可。手工新建的日历留在 'other'，
-- 由管理端补选。
update service_calendars set day_type='weekday' where id like '%\_weekday' escape '\';
update service_calendars set day_type='weekend' where id like '%\_weekend' escape '\';
update service_calendars set day_type='holiday' where id like '%\_holiday' escape '\';
update service_calendars set day_type='winter_break' where id like '%\_winterBreak' escape '\';
update service_calendars set day_type='summer_break' where id like '%\_summerBreak' escape '\';

-- 日型解析要按日期挑出命中的日历，有效期是第一道筛子。
create index idx_service_calendars_range on service_calendars(valid_from, valid_to);
