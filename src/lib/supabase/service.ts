// ============================================================
// 服务端 service-role 客户端 — 仅限「无用户会话的系统路径」使用：
// 节拍器 webhook、cron 编排、集成同步。这些路径有自己的鉴权
// （webhook key / CRON_SECRET），RLS 收紧后不能再以 anon 身份写库。
//
// ⚠️ 只能在服务端代码（route handler / server action）引用，
//    禁止出现在任何 'use client' 文件——service key 等于完全数据库权限。
// 部署要求：Vercel 环境变量需配置 SUPABASE_SERVICE_ROLE_KEY；
// 未配置时回退到 anon key 并 console.warn（RLS 收紧后回退路径的写入会被拒，
// 属预期安全行为——补上环境变量即恢复）。
// ============================================================
import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL 未配置')
  if (!serviceKey) {
    console.warn('[service-client] SUPABASE_SERVICE_ROLE_KEY 未配置，回退 anon key（RLS 收紧后系统写入将被拒绝）')
    return createSupabaseClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '', { auth: { persistSession: false } })
  }
  return createSupabaseClient(url, serviceKey, { auth: { persistSession: false } })
}
