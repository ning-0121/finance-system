// ============================================================
// POST /api/purchase-approvals/decide
// 财务对 ≥¥5000 采购单批准/驳回 → 更新 fin_purchase_orders + 回传节拍器放行/拦下。
// ============================================================
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { sendApprovalToMetronome } from '@/lib/integration/client'
import { normalizeOrderRefs } from '@/lib/integration/order-refs'

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
    .select('id, purchase_order_id, po_no, supplier_name, total_amount, currency, fin_status, order_refs')
    .eq('purchase_order_id', poId).is('deleted_at', null).single()
  if (poErr || !po) return NextResponse.json({ error: '采购单不存在' }, { status: 404 })
  if (po.fin_status !== 'pending_approval') {
    return NextResponse.json({ error: `采购单当前状态为「${po.fin_status}」,非待审批,不可重复审批` }, { status: 409 })
  }

  // 1.5 预算闸门(老板 2026-07-11):批准前,关联订单必须已生成预算单。
  //     驳回不受限;历史 order_refs 非 UUID(无法解析到 synced_orders)时不拦(否则旧单永远批不了)。
  if (decision === 'approved') {
    const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    const refs = normalizeOrderRefs(po.order_refs).map(r => r.id).filter(isUuid)
    if (refs.length > 0) {
      const { data: synced } = await supabase.from('synced_orders')
        .select('id, order_no, style_no, budget_order_id').in('id', refs)
      const foundById = new Map((synced || []).map(s => [String((s as { id: string }).id), s as { order_no?: string; style_no?: string; budget_order_id?: string | null }]))
      // 审计P2:闸门此前只 filter「查到的行」——订单从未同步到 synced_orders 时返回 0 行 → missing=[] 直接放行,
      //   与「必须已生成预算单」相悖。改为:未同步的 ref 也算缺预算(查无此单=无预算,更该拦)。
      const missing = refs.filter(id => {
        const s = foundById.get(id)
        return !s || !s.budget_order_id
      })
      if (missing.length > 0) {
        const names = missing.map(id => { const s = foundById.get(id); return s?.style_no || s?.order_no || `未同步订单(${id.slice(0, 8)})` }).join('、')
        return NextResponse.json({
          error: `关联订单尚未生成预算单(${names}),请先在本页「生成预算草稿」完成预算,再批准放行`,
          code: 'BUDGET_REQUIRED',
        }, { status: 409 })
      }
    }
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
