-- 回滚：对接三张表（注意会丢入站事件登记与采购单数据）
DROP TABLE IF EXISTS public.fin_po_lines;
DROP TABLE IF EXISTS public.fin_purchase_orders;
DROP TABLE IF EXISTS public.fin_inbox_events;
