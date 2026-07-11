-- 回滚 20260711_payable_state_batch_fix:
-- 1) 状态机恢复 20260511 原版(不认 partially_paid)
CREATE OR REPLACE FUNCTION trg_payable_status_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_old text := OLD.payment_status;
  v_new text := NEW.payment_status;
BEGIN
  IF v_old = v_new THEN RETURN NEW; END IF;
  IF NOT (
    (v_old = 'unpaid'           AND v_new IN ('pending_approval', 'cancelled')) OR
    (v_old = 'pending_approval' AND v_new IN ('approved', 'cancelled')) OR
    (v_old = 'approved'         AND v_new IN ('paid', 'cancelled')) OR
    (v_old = 'cancelled'        AND v_new = 'unpaid')
  ) THEN
    RAISE EXCEPTION '非法状态转换: payable_records.payment_status % → %', v_old, v_new;
  END IF;
  IF v_old = 'paid' THEN
    RAISE EXCEPTION '已过账: payable_records 已付款不可修改状态';
  END IF;
  RETURN NEW;
END;
$$;
-- 2) execute_batch_line_payment 恢复:重跑 migrations/20260705_payment_batch_rpc_authz.sql 中该函数定义
