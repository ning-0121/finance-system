-- ============================================================
-- 跨系统 SSO(节拍器→财务)防重放 nonce 表
-- 节拍器签名令牌带 nonce,财务 /api/auth/sso 用后即插入;唯一冲突=重放,拒绝。
-- 仅 service-role 写(SSO 路由),RLS 开启无策略=其他角色不可读写。
-- 加法式、幂等。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sso_nonces (
  nonce       text PRIMARY KEY,
  email       text,
  used_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_sso_nonces_expires ON public.sso_nonces (expires_at);
ALTER TABLE public.sso_nonces ENABLE ROW LEVEL SECURITY;  -- 无策略:仅 service-role(绕 RLS)可用

DO $do$ BEGIN RAISE NOTICE '✓ sso_nonces 已就绪(SSO 防重放)'; END $do$;
