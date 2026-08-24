-- 0027_marker_scale_continuous.sql — 图钉大小改连续系数
--
-- 0026 的 marker_size 是三档枚举（small/standard/large）带 CHECK。管理端需要
-- 在 0.5~2.0 范围内连续调节，SQLite 不能改 CHECK 约束，而 marker_size 只是
-- 普通列（无索引/外键依赖），用「加列 → 映射 →  drop 旧列 → 改名」原地替换，
-- 不碰引用 transit_stops 的外键表。存量档位映射：small→0.72、large→1.35、
-- 其他（standard）→1。新列存十进制字符串，范围校验上移到 worker。

pragma foreign_keys = on;

alter table transit_stops add column marker_scale text not null default '1';

update transit_stops set marker_scale = case marker_size
  when 'small' then '0.72'
  when 'large' then '1.35'
  else '1'
end;

alter table transit_stops drop column marker_size;

alter table transit_stops rename column marker_scale to marker_size;
