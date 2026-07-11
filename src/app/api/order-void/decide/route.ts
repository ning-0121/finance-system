// ============================================================
// POST /api/order-void/decide   —— 财务对作废申请终审(切片3)
//   批准 → 复跑体检 → 级联软删(可恢复)→ 落 approved + cascade_result
//   驳回 → 落 rejected,订单不动
// 权限:驳回=财务任意角色;批准=finance_manager/admin;含🔴须 admin 且勾 force。
// 自审阻断:发起人 ≠ 终审人。审批人记真实 auth.uid。
// ============================================================
import { NextResponse } from 'next/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { createServiceClient } from '@/lib/supabase/service'
import { preflightOrderVoid, cascadeVoidOrder } from '@/lib/financial/order-void'

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  let body: { requestId?: string; decision?: string; note?: string; force?: boolean }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const requestId = String(body.requestId || '')
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null
  const note = (body.note || '').trim() || null
  if (!requestId || !decision) return NextResponse.json({ error: '缺少 requestId 或 decision' }, { status: 400 })

  const sb = createServiceClient()

  // 1. 取作废申请 + 校验待审
  const { data: req, error: reqErr } = await sb.from('order_void_requests')
    .select('id, budget_order_id, status, requested_by, reason').eq('id', requestId).maybeSingle()
  if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 })
  if (!req) return NextResponse.json({ error: '作废申请不存在' }, { status: 404 })
  if (req.status !== 'pending') return NextResponse.json({ error: `该申请已是「${req.status}」,不可重复处理` }, { status: 409 })

  // 2. 自审阻断
  if (req.requested_by === auth.userId) return NextResponse.json({ error: '不能终审自己发起的作废申请' }, { status: 403 })

  const isAdmin = auth.role === 'admin'
  const deciderName = await nameOf(sb, auth.userId!)

  // ── 驳回:财务任意角色 ──
  if (decision === 'rejected') {
    const roleErr = requireRole(auth, ['finance_staff', 'finance_manager', 'admin'])
    if (roleErr) return roleErr
    const { error } = await sb.from('order_void_requests').update({
      status: 'rejected', decided_by: auth.userId, decider_name: deciderName, decision_note: note, decided_at: new Date().toISOString(),
    }).eq('id', requestId).eq('status', 'pending')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, decision: 'rejected' })
  }

  // ── 批准:finance_manager / admin ──
  const roleErr = requireRole(auth, ['finance_manager', 'admin'])
  if (roleErr) return roleErr

  // 3. 复跑体检(权威;发起后数据可能变化)
  const report = await preflightOrderVoid(sb, req.budget_order_id)
  if (report.hasBlocker && !isAdmin) {
    return NextResponse.json({ error: '含已付款/已收款/已下采购(🔴),须管理员处理' }, { status: 409 })
  }
  if (report.hasBlocker && isAdmin && !body.force) {
    return NextResponse.json({ error: '含🔴项,请确认相关款项已红冲后勾选强制作废', needForce: true }, { status: 409 })
  }

  // 4. 级联软删
  const cascade = await cascadeVoidOrder(sb, report, {
    actorId: auth.userId!, reason: req.reason, requestId, allowBlocked: isAdmin && !!body.force,
  })

  // 5. 落终审结论(即使有部分错误也记录,cascade.errors 供排查)
  const { error: updErr } = await sb.from('order_void_requests').update({
    status: 'approved', decided_by: auth.userId, decider_name: deciderName, decision_note: note,
    decided_at: new Date().toISOString(), cascade_result: cascade,
  }).eq('id', requestId).eq('status', 'pending')
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, decision: 'approved', errors: cascade.errors, softDeleted: Object.keys(cascade.financial).length })
}

async function nameOf(sb: ReturnType<typeof createServiceClient>, userId: string): Promise<string> {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle()
  const p = data as Record<string, unknown> | null
  return (p?.full_name as string) || (p?.name as string) || (p?.email as string) || '财务'
}
