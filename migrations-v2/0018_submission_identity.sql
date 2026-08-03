pragma foreign_keys = on;

-- 用户提交的身份与管理端账号体系打通。
--
-- 0001 给 content_submissions 只留了 submitter_name / submitter_contact 两列自由
-- 文本，它们来自请求体，任何人都能填任何值，因此无法回答「这条数据是谁传的」。
-- 采集链路（collection_tasks）在 0009/0010 已经改成认账号（assignee_user_id），
-- 但它生成的 content_submissions 行仍然只带一个昵称字符串，管理端看不到账号。
--
-- 这里补上真正的身份列。外键 on delete set null：账号注销后提交内容仍在，只是
-- 归属未知，不会连带删掉审核记录。
--
-- 迁移号说明：0017 留给同期并行开发的另一条改动，编号跳过不影响应用顺序
-- （wrangler 按文件名字典序执行，0007 同样从未存在）。
alter table content_submissions add column submitter_user_id text references users(id) on delete set null;

create index idx_content_submissions_submitter
  on content_submissions(submitter_user_id, created_at desc);

-- 回填能确证的那部分：采集提交与 collection_tasks 一一对应（submission_id 唯一
-- 指向一行任务），而任务行自 0009 起记录了领取账号。这是唯一无损的映射来源。
--
-- 反馈提交（POST /api/public/submissions）在本次改动前是匿名端点，没有会话，
-- 因此**不做**任何猜测式回填：submitter_name 是自由文本，users.display_name 没有
-- 唯一约束，靠名字匹配可能把陌生人的提交挂到别人账号上（同 0010 的判断）。
-- 这些历史行的 submitter_user_id 保持 NULL，管理端显示为「匿名（改动前）」。
update content_submissions
   set submitter_user_id=(
     select ct.assignee_user_id
       from collection_tasks ct
      where ct.submission_id=content_submissions.id
        and ct.assignee_user_id is not null
   )
 where submitter_user_id is null
   and exists (
     select 1 from collection_tasks ct
      where ct.submission_id=content_submissions.id
        and ct.assignee_user_id is not null
   );

-- 契约：回填只能落在采集提交上，且必须指向真实存在的账号。
create table submission_identity_guard (
  valid integer not null check (valid=1)
);

insert into submission_identity_guard(valid)
select 1 where not exists (
  select 1 from content_submissions s
   where s.submitter_user_id is not null
     and not exists (select 1 from users u where u.id=s.submitter_user_id)
);

insert into submission_identity_guard(valid)
select 1 where not exists (
  select 1 from content_submissions s
   where s.submitter_user_id is not null
     and not exists (
       select 1 from collection_tasks ct
        where ct.submission_id=s.id
          and ct.assignee_user_id=s.submitter_user_id
     )
);

drop table submission_identity_guard;
