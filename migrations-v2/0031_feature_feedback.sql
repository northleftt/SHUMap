-- 0031_feature_feedback.sql — 功能评分反馈（「你觉得这个功能好用吗」）
--
-- 与 content_submissions 的区别：那边是内容纠错 / 采集（要审核、会产生修订、
-- 影响公开内容），这张表是纯运营数据——用户对某个功能页（搜索、校车）打 1-5 星，
-- 低分可附一句原因。因此它不进审核队列、不进发布流，搜索 / 校车的读取路径
-- 也永远不查它，只给管理端一个列表看趋势。
--
-- 决策：
--   page 用长度约束（1-50）而不是 in 枚举——挂反馈入口的页面会随版本增加，
--     加新页面不该要求改库；page 只是分组键，未知值顶多在管理端过滤不出，
--     不会污染别的数据。worker 层同样只校验格式不做枚举。
--   rating 1-5 用 check 钉死在库里：这是统计的根基，混进脏值平均分就没意义了。
--   reason 可空、任何评分都可附（不只低分），长度上限仅作防滥用兜底；
--     具体引导（低分时鼓励填写）是前端的事，不写成库约束。
--   无 updated_at：评分是不可变事实，没有编辑场景。

pragma foreign_keys = on;

create table feature_feedback (
  id text primary key,
  page text not null check (length(page) between 1 and 50),
  rating integer not null check (rating between 1 and 5),
  reason text check (reason is null or length(reason) <= 500),
  created_at text not null
);

create index idx_feature_feedback_created on feature_feedback(created_at desc);
create index idx_feature_feedback_page_created on feature_feedback(page, created_at desc);
