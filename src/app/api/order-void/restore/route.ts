// ============================================================
// POST /api/order-void/restore  —— 撤销一次已批准的作废(切片3)
// 按 cascade_result 精确回滚软删/作废,订单及子数据恢复。仅管理员(admin)。
// ============================================================
import { NextResponse } from 'next/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { createServiceClient } from '@/lib/supabase/service'
import { restoreVoidedOrder, type CascadeResult } from '@/lib/financial/order-void'

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const roleErr = requireRole(auth, ['admin'])
  if (roleErr) return roleErr

  let body: { requestId?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const requestId = String(body.requestId || '')
  if (!requestId) return NextResponse.json({ error: '缺少 requestId' }, { status: 400 })

  const sb = createServiceClient()
  const { data: req, error: reqErr } = await sb.from('order_void_requests')
    .select('id, status, cascade_result').eq('id', requestId).maybeSingle()
  if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 })
  if (!req) return NextResponse.json({ error: '作废申请不存在' }, { status: 404 })
  if (req.status !== 'approved') return NextResponse.json({ error: `仅已批准的作废可恢复(当前「${req.status}」)` }, { status: 409 })
  if (!req.cascade_result) return NextResponse.json({ error: '无级联结果,无法精确恢复' }, { status: 409 })

  const { errors } = await restoreVoidedOrder(sb, req.cascade_result as CascadeResult)

  // 作废单标记为 cancelled(= 作废已被撤销/恢复)
  await sb.from('order_void_requests').update({
    status: 'cancelled', decision_note: '作废已由管理员恢复', decided_at: new Date().toISOString(),
  }).eq('id', requestId)

  return NextResponse.json({ ok: true, errors })
}
