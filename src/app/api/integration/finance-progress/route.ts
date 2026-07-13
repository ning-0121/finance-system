// ============================================================
// POST /api/integration/finance-progress
// 财务侧的收款/付款进度 → 回传节拍器(往返完整性:此前只有 settlement.closed 回传,
// collection.received / payment.completed 从不发,采购/订单部门看不到资金进度)。
// 客户端流程(回款登记、排款放款)成功后 fire-and-forget 打这个口;服务端持密钥回传。
// ============================================================
import { NextResponse } from 'next/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { createServiceClient } from '@/lib/supabase/service'
import { notifyFinanceProgress, type FinanceProgressEvent } from '@/lib/integration/client'

const ALLOWED: FinanceProgressEvent[] = ['collection.received', 'payment.completed', 'settlement.closed', 'budget.confirmed']

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const roleErr = requireRole(auth, ['finance_staff', 'finance_manager', 'admin'])
  if (roleErr) return roleErr

  let body: { event?: string; qimo_order_id?: string | null; order_no?: string | null; internal_order_no?: string | null; amount?: number; currency?: string; note?: string; source_ref?: string | null }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const event = body.event as FinanceProgressEvent
  if (!ALLOWED.includes(event)) return NextResponse.json({ error: '不支持的进度事件' }, { status: 400 })

  // 审计P1.4:按真实状态校验,不许凭空宣告。budget.confirmed 会开绮陌采购硬闸门——
  // 必须对应一张【已审批】预算单(否则单人一条 POST 就能放行未审批订单下采购)。
  if (event === 'budget.confirmed') {
    const qid = body.qimo_order_id ?? null
    if (!qid) return NextResponse.json({ error: 'budget.confirmed 缺 qimo_order_id,无法核验预算单状态' }, { status: 400 })
    const svc = createServiceClient()
    const { data: bo } = await svc.from('budget_orders')
      .select('id, status').eq('qimo_order_id', qid).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!bo) return NextResponse.json({ error: '该订单在财务侧无预算单,不能宣告预算已确认' }, { status: 409 })
    if (bo.status !== 'approved') return NextResponse.json({ error: `预算单当前为「${bo.status}」,非 approved,不能回传 budget.confirmed` }, { status: 409 })
  }

  // 至少要有一个订单锚点,否则节拍器无法挂到订单(不阻断,只是提示)
  const r = await notifyFinanceProgress(event, {
    qimo_order_id: body.qimo_order_id ?? null,
    order_no: body.order_no ?? null,
    internal_order_no: body.internal_order_no ?? null,
    amount: body.amount,
    currency: body.currency,
    note: body.note,
    source_ref: body.source_ref ?? null,   // 采购对账付款回传锚(节拍器累加对账 paid_amount、付满转 paid)
  })
  // 回传失败已在 client 层入 outbox 重试;这里只回报结果,不阻断业务
  return NextResponse.json({ ok: true, sent: r.success, error: r.success ? undefined : r.error })
}
