-- 回滚:删除杂项应收表 misc_receivables(仅在确无数据/需回退时)。⚠️ 财务库执行。
DROP TABLE IF EXISTS public.misc_receivables;
