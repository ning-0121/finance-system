// ============================================================
// POST /api/purchase-approvals/decide
// 财务对 ≥¥5000 采购单批准/驳回 → 更新 fin_purchase_orders + 回传节拍器放行/拦下。
// ============================================================
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { sendApprovalToMetronome } from '@/lib/integration/client'

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  // 财务审核权限(财务与采购天然分离——采购在节拍器,审批在财务)
  const roleErr = requireRole(auth, ['finance_staff', 'finance_manager', 'admin'])
  if (roleErr) return roleErr

  let body: { purchase_order_id?: string; decision?: string; note?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const poId = String(body.purchase_order_id || '')
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null
  const note = (body.note || '').trim() || null
  if (!poId || !decision) return NextResponse.json({ error: '缺少 purchase_order_id 或 decision' }, { status: 400 })

  const supabase = await createClient()

  // 1. 取单 + 校验处于待审批
  const { data: po, error: poErr } = await supabase.from('fin_purchase_orders')
    .select('id, purchase_order_id, po_no, supplier_name, total_amount, currency, fin_status')
    .eq('purchase_order_id', poId).is('deleted_at', null).single()
  if (poErr || !po) return NextResponse.json({ error: '采购单不存在' }, { status: 404 })
  if (po.fin_status !== 'pending_approval') {
    return NextResponse.json({ error: `采购单当前状态为「${po.fin_status}」,非待审批,不可重复审批` }, { status: 409 })
  }

  // 2. 落审批结论
  const { data: updated, error: updErr } = await supabase.from('fin_purchase_orders')
    .update({
      fin_status: decision,
      approval_decided_by: auth.userId,
      approval_decided_at: new Date().toISOString(),
      approval_note: note,
    })
    .eq('id', po.id).eq('fin_status', 'pending_approval')   // 乐观锁:并发下只有一人成功
    .select('id')
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: '采购单已被他人审批或无权限' }, { status: 409 })
  }

  // 3. 回传节拍器(放行/拦下)。失败不回滚审批结论——记为「待回传」,可重推。
  const { data: prof } = await supabase.from('profiles').select('*').eq('id', auth.userId!).single()
  const deciderName = (prof as Record<string, unknown> | null)?.full_name as string
    || (prof as Record<string, unknown> | null)?.name as string
    || (prof as Record<string, unknown> | null)?.email as string || '财务'

  const cb = await sendApprovalToMetronome({
    approval_id: po.purchase_order_id,
    approval_type: 'purchase',
    decision,
    decided_by: auth.userId!,
    decider_name: deciderName,
    decision_note: note,
    decided_at: new Date().toISOString(),
    po_no: po.po_no,
  })
  if (cb.success) {
    await supabase.from('fin_purchase_orders').update({ approval_callback_at: new Date().toISOString() }).eq('id', po.id)
  }

  return NextResponse.json({
    ok: true, decision, po_no: po.po_no,
    callback: cb.success ? 'sent' : 'failed',
    callback_error: cb.success ? undefined : cb.error,
  })
}
