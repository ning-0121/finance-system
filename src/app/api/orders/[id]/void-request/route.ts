// ============================================================
// POST /api/orders/[id]/void-request
// 发起「订单作废申请」→ 体检分级 → 落 order_void_requests(pending),进财务作废队列。
// 不删任何数据;真正级联软删在切片3 财务终审后。
// 发起人:创建人本人 或 财务角色(记真实 auth.uid);节拍器来源在切片4。
// ============================================================
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { createServiceClient } from '@/lib/supabase/service'
import { preflightOrderVoid } from '@/lib/financial/order-void'

const FINANCE_ROLES = ['finance_staff', 'finance_manager', 'admin']

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { id } = await params
  if (!id) return NextResponse.json({ error: '缺少订单 id' }, { status: 400 })

  let body: { reason?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const reason = (body.reason || '').trim()
  if (reason.length < 4) return NextResponse.json({ error: '请填写作废原因(至少 4 字)' }, { status: 400 })

  const sb = createServiceClient()

  // 1. 取订单 + 校验存在/未删 + 发起权限(创建人本人 或 财务)
  const { data: bo, error: boErr } = await sb.from('budget_orders')
    .select('id, order_no, created_by, deleted_at').eq('id', id).maybeSingle()
  if (boErr) return NextResponse.json({ error: boErr.message }, { status: 500 })
  if (!bo) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
  if (bo.deleted_at) return NextResponse.json({ error: '订单已作废' }, { status: 409 })

  const isFinance = FINANCE_ROLES.includes(auth.role || '')
  const isCreator = bo.created_by === auth.userId
  if (!isFinance && !isCreator) {
    return NextResponse.json({ error: '仅订单创建人或财务可发起作废' }, { status: 403 })
  }

  // 2. 幂等:已有未决作废申请 → 直接返回它,不重复建
  const { data: existing } = await sb.from('order_void_requests')
    .select('id, severity, status').eq('budget_order_id', id).eq('status', 'pending').maybeSingle()
  if (existing) {
    return NextResponse.json({ ok: true, already: true, id: existing.id, severity: existing.severity })
  }

  // 3. 服务端复跑体检(权威快照)
  const report = await preflightOrderVoid(sb, id)

  // 4. 发起人姓名(留痕)
  const { data: prof } = await sb.from('profiles').select('*').eq('id', auth.userId!).maybeSingle()
  const p = prof as Record<string, unknown> | null
  const requesterName = (p?.full_name as string) || (p?.name as string) || (p?.email as string) || '未知'

  // 5. 落库(status=pending;真实发起人)
  const { data: ins, error: insErr } = await sb.from('order_void_requests').insert({
    budget_order_id: id,
    order_no: bo.order_no,
    qm_order_no: report.qmOrderNo,
    internal_no: report.internalNo,
    source: isFinance ? 'finance' : 'creator',
    reason,
    severity: report.severity,
    blockers: report.items,
    status: 'pending',
    requested_by: auth.userId,
    requested_by_name: requesterName,
  }).select('id').single()

  if (insErr) {
    // 并发:唯一索引(每单仅一个 pending)撞车 → 取回已存在的
    const { data: race } = await sb.from('order_void_requests')
      .select('id, severity').eq('budget_order_id', id).eq('status', 'pending').maybeSingle()
    if (race) return NextResponse.json({ ok: true, already: true, id: race.id, severity: race.severity })
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id: ins.id, severity: report.severity })
}
