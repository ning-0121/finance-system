-- ============================================================
-- 允许 cost_items 负金额（扣款/退货/退布/冲减）
-- 背景：schema-security 加的 chk_cost_amount_non_negative (amount>=0) 是一刀切
--   的数据完整性护栏，但业务真实存在负成本行——如「试错纸箱重新买 -265 扣加工厂」、
--   「退布 -10067」、「定金退回 -5000」。这些是对某供应商的成本冲减，天然为负。
-- 下游决算/GL/成本桶都是按金额求和(无 amount>0 过滤)，负数自然抵减，口径正确。
-- 仅放开 cost_items 明细行；汇率仍要求 >=0。可加可逆(回滚见 .down.sql)。
-- ============================================================
ALTER TABLE public.cost_items
  DROP CONSTRAINT IF EXISTS chk_cost_amount_non_negative;

-- 仍禁止 amount 为 NULL（保持非空），负数/正数皆可；0 由前端拦(无意义空行)
-- 汇率约束保留：
--   chk_cost_rate_non_negative 不动。
