-- ============================================================
-- P0-3b:payable_records 加 exchange_rate 权威汇率列
-- 背景(审计根因C):payable_records 只存 amount+currency、无汇率列 → 每个消费端(老板面板/
--   毛利表/对账)各自按订单汇率或 ||1/||0/||7.2 再折 CNY,同一笔应付的人民币值页页不同、不可复现。
-- 方案(低风险,不重写原子 RPC confirm_settlement_with_payables_atomic):
--   ① 加列;② 回填现有(CNY→1,外币→所属订单汇率);③ BEFORE INSERT 触发器自动从订单补汇率
--      (RPC 与 JS 两条插入路径都覆盖,应用侧无需改 RPC)。
-- 全部 additive/可逆(见 .down.sql:删触发器+函数+列)。缺汇率仍留 null,消费端 safeRate 兜底(→7+告警)。
-- ============================================================

-- ① 加列(幂等)
ALTER TABLE public.payable_records
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(12,4);

COMMENT ON COLUMN public.payable_records.exchange_rate IS
  '应付折人民币汇率(权威单一来源)。CNY=1;外币=所属订单汇率(建单时补);缺失=null→消费端 safeRate 兜底并告警。';

-- ② 回填现有行:CNY→1;外币→所属预算单汇率(仅填 exchange_rate 为空者,不覆盖)
UPDATE public.payable_records p
   SET exchange_rate = CASE
         WHEN COALESCE(p.currency, 'CNY') = 'CNY' THEN 1
         ELSE bo.exchange_rate
       END
  FROM public.budget_orders bo
 WHERE p.budget_order_id = bo.id
   AND p.exchange_rate IS NULL;

-- 无订单关联的人民币应付也置 1
UPDATE public.payable_records
   SET exchange_rate = 1
 WHERE exchange_rate IS NULL
   AND COALESCE(currency, 'CNY') = 'CNY';

-- ③ BEFORE INSERT 触发器:新应付若未带汇率,自动从所属订单补(CNY→1,外币→订单汇率)。
--    覆盖 RPC(confirm_settlement_with_payables_atomic)与 JS(generatePayablesFromSettlement)两条插入路径。
CREATE OR REPLACE FUNCTION public.fill_payable_exchange_rate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.exchange_rate IS NULL THEN
    IF COALESCE(NEW.currency, 'CNY') = 'CNY' THEN
      NEW.exchange_rate := 1;
    ELSIF NEW.budget_order_id IS NOT NULL THEN
      SELECT bo.exchange_rate INTO NEW.exchange_rate
        FROM public.budget_orders bo
       WHERE bo.id = NEW.budget_order_id;
    END IF;
    -- 仍为 null(外币且订单也缺率)→ 留 null,由消费端 safeRate 兜底+告警,不在此臆造
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_payable_exchange_rate ON public.payable_records;
CREATE TRIGGER trg_fill_payable_exchange_rate
  BEFORE INSERT ON public.payable_records
  FOR EACH ROW EXECUTE FUNCTION public.fill_payable_exchange_rate();

-- 校验
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
   WHERE table_schema='public' AND table_name='payable_records' AND column_name='exchange_rate';
  IF v < 1 THEN RAISE EXCEPTION 'payable_records.exchange_rate 未加上'; END IF;
  RAISE NOTICE '✓ P0-3b:payable_records.exchange_rate 已加列+回填+触发器';
END $$;
