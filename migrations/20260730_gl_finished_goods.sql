-- ============================================================
-- 采购成品(经销单)独立核算:GL 科目 540104 + cost_items.cost_type='finished_goods'
--
-- 背景:经销单(order_purpose=trade/consign)不核料,采购的是成品。预算里 2026-07-30 已加
--   「采购成品」成本桶(_cost_breakdown.finished_goods + lines.finished_goods 逐行 数量/单价)。
--   但总账侧无对应科目:
--   ① 成本结转回退路径 gl-queue.ts 用 num('fabric', target_purchase_price) 取值——
--      cb.fabric>0 时返回 cb.fabric,采购成品金额被【整条丢掉】(结转成本 < 订单 total_cost);
--      仅当 cb.fabric=0 才走 fallback,把采购成品错记成「面料成本」。两种都不对。
--   ② 费用归集(cost_items)也没有成品类型,采购成品实际发生额只能挤进 procurement/other。
--
-- 本迁移:
--   1) 新增明细科目 540104 主营业务成本-采购成品(与 540101 面料/540102 辅料同层同向)。
--   2) 扩展 cost_items.cost_type 允许 'finished_goods'。
-- 应用层配套:gl-journal-builders.buildCostRecognition 增 finished_goods → 540104;
--   gl-queue 两条路径(cost_items 归集 / _cost_breakdown 回退)均单列该桶;gl-posting 同步。
--
-- 纯可加可逆(只 INSERT 一行科目 + 放宽 CHECK),不改既有数据、不动已过账凭证。
-- 回滚见 .down.sql(回滚前需先把 finished_goods 行改回 procurement,并确认无 540104 凭证行)。
-- ⚠️ 财务库执行。
-- ============================================================

-- 1. 科目表:主营业务成本-采购成品(经销单采购成品成本)
INSERT INTO public.accounts (account_code, account_name, account_type, level, balance_direction, is_detail, description)
VALUES ('540104', '主营业务成本-采购成品', 'expense', 2, 'debit', true, '经销单采购成品成本')
ON CONFLICT (account_code) DO NOTHING;

-- 2. 费用归集:允许 finished_goods 类型(采购成品实际发生额)
ALTER TABLE public.cost_items DROP CONSTRAINT IF EXISTS cost_items_cost_type_check;
ALTER TABLE public.cost_items ADD CONSTRAINT cost_items_cost_type_check
  CHECK (cost_type IN ('fabric', 'accessory', 'processing', 'freight', 'container', 'logistics', 'commission', 'customs', 'procurement', 'other', 'tax_point', 'finished_goods'));
