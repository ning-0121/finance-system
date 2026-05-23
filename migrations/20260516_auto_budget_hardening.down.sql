-- rollback: 20260516_auto_budget_hardening
DROP INDEX IF EXISTS idx_synced_orders_sync_status;
ALTER TABLE public.synced_orders
  DROP COLUMN IF EXISTS budget_sync_attempt_count,
  DROP COLUMN IF EXISTS budget_sync_attempted_at,
  DROP COLUMN IF EXISTS budget_sync_error,
  DROP COLUMN IF EXISTS budget_sync_status;
