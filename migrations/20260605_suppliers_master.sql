-- ============================================================
-- 供应商信息库（供应商主数据）
-- 目的：付款/费用录入时从主数据选择供应商，自动带出银行信息，
--       避免每次手填、避免输错把一家供应商拆成两家。
--
-- 字段：名称 / 账号 / 户名 / 开户行 / 联系人 / 电话 / 附件 / 备注
-- 可加可逆；RLS 采用系统统一的 USING(true) 口径。
-- 回滚见 20260605_suppliers_master.down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.suppliers (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           text NOT NULL,              -- 供应商名称
  account_no     text,                       -- 银行账号
  account_name   text,                       -- 户名
  bank_name      text,                       -- 开户行
  contact        text,                       -- 联系人
  phone          text,                       -- 电话
  attachment_url text,                       -- 附件（链接/存储路径）
  notes          text,                       -- 备注
  created_by     uuid REFERENCES public.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

-- 同名（未删除）唯一，防止重复建档
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name_active
  ON public.suppliers (name) WHERE deleted_at IS NULL;

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "suppliers_select" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_insert" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_update" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_delete" ON public.suppliers;
CREATE POLICY "suppliers_select" ON public.suppliers FOR SELECT USING (true);
CREATE POLICY "suppliers_insert" ON public.suppliers FOR INSERT WITH CHECK (true);
CREATE POLICY "suppliers_update" ON public.suppliers FOR UPDATE USING (true);
CREATE POLICY "suppliers_delete" ON public.suppliers FOR DELETE USING (true);

-- 验证：
-- SELECT to_regclass('public.suppliers');
