-- ============================================================
-- 汇总报表审核流程 — 在Supabase SQL Editor执行
-- ============================================================

CREATE TABLE IF NOT EXISTS public.report_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_type text NOT NULL CHECK (report_type IN ('supplier_statement','customer_statement','commission','tax_refund')),
  report_title text NOT NULL,
  period_start date,
  period_end date,
  filter_params jsonb DEFAULT '{}'::jsonb,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,    -- 汇总明细行
  total_amount numeric(15,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CNY',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewing','confirmed','locked')),
  -- 审核
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_notes text,
  -- 确认锁定
  confirmed_by uuid REFERENCES public.profiles(id),
  confirmed_at timestamptz,
  -- 修正记录
  corrections jsonb DEFAULT '[]'::jsonb,            -- [{line_index, field, old_value, new_value, reason, corrected_by, corrected_at}]
  correction_count integer NOT NULL DEFAULT 0,
  -- 元数据
  generated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.report_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "v_reports" ON public.report_snapshots FOR SELECT USING (true);
CREATE POLICY "m_reports" ON public.report_snapshots FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_report_type ON public.report_snapshots(report_type, status);
CREATE TRIGGER update_report_ts BEFORE UPDATE ON public.report_snapshots FOR EACH ROW EXECUTE PROCEDURE public.update_updated_at();
