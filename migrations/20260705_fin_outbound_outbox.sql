-- ============================================================
-- 财务→节拍器 发件箱(审计 P1×2)
-- 财务对节拍器的回传(notifyFinanceProgress 结算/收款/付款进度、sendApprovalToMetronome
-- 采购审批结论)此前 fire-and-forget:首发失败仅 console.error,无重试 → 进度永久丢、
-- 采购审批回传失败 PO 永久卡在待审。加发件箱:失败落库 + cron 退避重试;request_id 确定性
-- (内容键)→ 重发同键,节拍器幂等去重。
-- 加法式、幂等。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.fin_outbound_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target        text NOT NULL DEFAULT 'metronome',
  event         text NOT NULL,                 -- settlement.closed / collection.received / payment.completed / approval.callback
  payload       jsonb NOT NULL,                -- data(重发时按 event+payload+request_id 重建)
  request_id    text,                          -- 确定性幂等键
  status        text NOT NULL DEFAULT 'failed' -- failed(待重试)/ sent / dead(超上限待人工)
                  CHECK (status IN ('failed','sent','dead')),
  attempts      int  NOT NULL DEFAULT 1,
  last_error    text,
  next_retry_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_outbox_request_id ON public.fin_outbound_outbox (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_outbox_due ON public.fin_outbound_outbox (status, next_retry_at);

ALTER TABLE public.fin_outbound_outbox ENABLE ROW LEVEL SECURITY;
-- 写由 service-role(绕 RLS);登录用户可读(给失败队列管理页看)。
DROP POLICY IF EXISTS fin_outbox_read ON public.fin_outbound_outbox;
CREATE POLICY fin_outbox_read ON public.fin_outbound_outbox FOR SELECT TO authenticated USING (true);

DO $do$ BEGIN RAISE NOTICE '✓ fin_outbound_outbox 已就绪(财务→节拍器回传失败落库+重试)'; END $do$;
