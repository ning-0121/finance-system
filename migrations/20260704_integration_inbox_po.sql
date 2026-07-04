-- ============================================================
-- 补档：订单系统对接三张表的 DDL 入版本库
-- ⚠ 本 DDL 已于 2026-07-03 在生产 Supabase 手动执行(当时经聊天交付,漏入 migrations,
--   审计 P1 指出违反"生产变更必须进版本库"红线)。本文件为幂等补档:
--   生产重跑无害(IF NOT EXISTS)；新环境/灾备重建靠它。
-- ============================================================

-- 1) 入站事件登记簿(inbox)：request_id 唯一=幂等锚点
CREATE TABLE IF NOT EXISTS public.fin_inbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     text NOT NULL UNIQUE,
  event          text NOT NULL,
  source         text NOT NULL DEFAULT 'order-metronome',
  payload        jsonb NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  process_status text NOT NULL DEFAULT 'pending'
                 CHECK (process_status IN ('pending','processing','done','failed','ignored')),
  processed_at   timestamptz,
  attempt_count  int NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX IF NOT EXISTS idx_fin_inbox_status ON public.fin_inbox_events(process_status, received_at);
CREATE INDEX IF NOT EXISTS idx_fin_inbox_event  ON public.fin_inbox_events(event, received_at);

ALTER TABLE public.fin_inbox_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_inbox_read ON public.fin_inbox_events;
CREATE POLICY fin_inbox_read ON public.fin_inbox_events
  FOR SELECT TO authenticated USING (true);
-- 写入仅 service_role(webhook 服务端)

-- 2) 采购单头(V1.0)
CREATE TABLE IF NOT EXISTS public.fin_purchase_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id  text NOT NULL UNIQUE,
  po_no              text NOT NULL,
  supplier_id        text,
  supplier_name      text,
  total_amount       numeric(15,2),
  currency           text NOT NULL DEFAULT 'CNY',
  payment_terms      text,
  delivery_date      date,
  status             text,
  placed_at          timestamptz,
  order_refs         jsonb,
  source_request_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_fin_po_supplier ON public.fin_purchase_orders(supplier_name);
CREATE INDEX IF NOT EXISTS idx_fin_po_no       ON public.fin_purchase_orders(po_no);

ALTER TABLE public.fin_purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_po_read ON public.fin_purchase_orders;
CREATE POLICY fin_po_read ON public.fin_purchase_orders
  FOR SELECT TO authenticated USING (true);

-- 3) 采购行(V1.1 契约预留)
CREATE TABLE IF NOT EXISTS public.fin_po_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fin_po_id          uuid NOT NULL REFERENCES public.fin_purchase_orders(id),
  line_id            text UNIQUE,
  order_id           text,
  order_no           text,
  internal_order_no  text,
  style_no           text,
  material_name      text,
  material_code      text,
  specification      text,
  category           text,
  ordered_qty        numeric(15,3),
  ordered_unit       text,
  unit_price         numeric(15,4),
  amount             numeric(15,2),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_po_lines_po    ON public.fin_po_lines(fin_po_id);
CREATE INDEX IF NOT EXISTS idx_fin_po_lines_style ON public.fin_po_lines(style_no);

ALTER TABLE public.fin_po_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_po_lines_read ON public.fin_po_lines;
CREATE POLICY fin_po_lines_read ON public.fin_po_lines
  FOR SELECT TO authenticated USING (true);
