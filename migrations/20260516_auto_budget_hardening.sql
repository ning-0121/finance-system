-- ============================================================
-- 20260516 Auto-Budget P1 加固
-- 修复: webhook/route.ts:156 console.error 静默失败 + 无 sync_status + 无幂等
-- ============================================================

-- 1. synced_orders 加 sync_status 枚举列 + 错误详情列
ALTER TABLE public.synced_orders
  ADD COLUMN IF NOT EXISTS budget_sync_status text NOT NULL DEFAULT 'pending'
    CHECK (budget_sync_status IN (
      'pending',           -- 未尝试
      'draft_created',     -- 成功生成预算草稿
      'draft_skipped',     -- 已存在预算单 → 幂等跳过
      'no_amount_skipped', -- 无金额信息 → 业务规则跳过
      'no_actor_skipped',  -- 无可用 actor profile（部署初期可能）
      'draft_failed',      -- 异常失败（写错误详情到 budget_sync_error）
      'manual_review'      -- 进入待处理队列（人工接管）
    )),
  ADD COLUMN IF NOT EXISTS budget_sync_error text,        -- 失败原因（仅 draft_failed 时填）
  ADD COLUMN IF NOT EXISTS budget_sync_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS budget_sync_attempt_count int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_synced_orders_sync_status
  ON public.synced_orders (budget_sync_status)
  WHERE budget_sync_status IN ('draft_failed', 'manual_review', 'pending');

-- 2. 验证
DO $$
DECLARE v_cols int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
    WHERE table_schema='public' AND table_name='synced_orders'
      AND column_name IN ('budget_sync_status','budget_sync_error','budget_sync_attempted_at','budget_sync_attempt_count');
  IF v_cols <> 4 THEN RAISE EXCEPTION 'synced_orders 缺列: %', v_cols; END IF;
  RAISE NOTICE '✓ 20260516 auto-budget 加固 schema 已就绪 (4 列)';
END $$;
