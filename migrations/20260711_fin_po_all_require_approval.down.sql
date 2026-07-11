-- 回滚:把【尚未决策】的 pending_approval 采购单退回 pending。
-- ⚠️ 说明:无法区分「本迁移迁上来的」与「回滚后新收单落成的」pending_approval,
--   故按「未决策(approval_decided_at IS NULL)」统一退回 —— 这是回滚整个
--   「所有采购单须审批」特性时的预期行为。已批/已驳(approval_decided_at 有值)不动。
UPDATE public.fin_purchase_orders
   SET fin_status = 'pending',
       updated_at = now()
 WHERE fin_status = 'pending_approval'
   AND approval_decided_at IS NULL
   AND deleted_at IS NULL;
