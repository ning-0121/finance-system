-- ============================================================
-- 客户扣款 receivable_deductions(2026-08-05)
--
-- 业务实证:1022852(年年旺)应收 ¥222,750,客人只付 ¥100,710,扣款 ¥122,040。
-- 这 ¥122,040 既不是「已收」也不是「合同金额录错」,系统里却没有第三种记法:
--   · 用「核销」→ 实现是造一笔【假回款流水】再匹配掉,会把已收从 10 万抬到 22 万,
--     回款率虚高,且银行对账多出一笔没有进账的流水。
--   · 用「修正应收金额」→ 把合同额改小,扣了多少、为什么扣就永远查不到了。
-- 所以必须有独立的一类:减应收、不进已收、留原因与性质。
--
-- 应收余额 = 合同额 − 已收(回款分配) − 扣款(本表)
--
-- treatment 决定会计处理,两者对利润的影响完全不同,必须由财务显式选择:
--   reduce_revenue(销售折让:质量索赔、客户折让)→ 冲减收入,毛利率下降
--   expense       (费用性扣款:迟交罚款、代扣运费)→ 计入费用,收入不变
--
-- 治理:写入必须是财务角色且记真实 auth.uid();金额>0;可作废(软删)不可物理删。
-- 可加可逆,回滚见 .down.sql。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.receivable_deductions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_order_id  uuid NOT NULL REFERENCES public.budget_orders(id),
  customer_id      uuid REFERENCES public.customers(id),
  customer_name    text,
  -- 金额:原币 + 折算,与回款流水同口径(外币扣款按扣款当时汇率折 CNY)
  amount_original  numeric(15,2) NOT NULL CHECK (amount_original > 0),
  currency         text NOT NULL DEFAULT 'CNY',
  exchange_rate    numeric(12,4) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  amount_cny       numeric(15,2) NOT NULL CHECK (amount_cny > 0),
  -- 扣款性质:决定会计处理
  deduction_type   text NOT NULL CHECK (deduction_type IN
                     ('quality_claim','late_penalty','freight_deduct','discount','short_ship','other')),
  treatment        text NOT NULL CHECK (treatment IN ('reduce_revenue','expense')),
  reason           text NOT NULL,              -- 必填:扣了什么、依据是什么
  occurred_at      date NOT NULL,              -- 扣款发生日(非录入日)
  evidence_url     text,                       -- 客户扣款单/索赔函
  notes            text,
  -- 留痕
  created_by       uuid REFERENCES public.profiles(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  voided_by        uuid REFERENCES public.profiles(id),
  void_reason      text
);

CREATE INDEX IF NOT EXISTS idx_recv_deductions_order
  ON public.receivable_deductions (budget_order_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recv_deductions_customer
  ON public.receivable_deductions (customer_id) WHERE voided_at IS NULL;

-- 作废必须写原因(与本系统其他软删同规矩:不能默默抹掉)
ALTER TABLE public.receivable_deductions DROP CONSTRAINT IF EXISTS recv_deductions_void_chk;
ALTER TABLE public.receivable_deductions ADD CONSTRAINT recv_deductions_void_chk
  CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND voided_by IS NOT NULL));

ALTER TABLE public.receivable_deductions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recv_deductions_read ON public.receivable_deductions;
CREATE POLICY recv_deductions_read ON public.receivable_deductions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS recv_deductions_write ON public.receivable_deductions;
CREATE POLICY recv_deductions_write ON public.receivable_deductions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
                 AND p.role IN ('finance','finance_staff','finance_manager','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
                 AND p.role IN ('finance','finance_staff','finance_manager','admin')));

-- 自验证
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
   WHERE table_name='receivable_deductions'
     AND column_name IN ('budget_order_id','amount_cny','deduction_type','treatment','reason');
  IF v < 5 THEN RAISE EXCEPTION 'receivable_deductions 关键列缺失 (count=%)', v; END IF;
  RAISE NOTICE '✓ receivable_deductions 已就绪(客户扣款:减应收、不进已收)';
END $$;
