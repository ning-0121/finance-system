// POST /api/integration/create-budget
// 「新到订单」收件箱：财务审完业务上传的 PO(单价/件数/总额)后,一键为【单条】已同步订单建预算单草稿。
// 复用 /api/integration/sync 的「建单-或-复用」逻辑,但只作用于一条 synced_order。
//
// 与 webhook 自动建单的关系:webhook 的 autoCreateBudgetDraft 对「无金额」订单会 no_amount_skipped、
// 不建预算,导致业务刚上传、尚未定价的 PO 在财务侧不可见(老问题)。本接口让财务在收件箱里
// 显式建单(即使暂无金额也建 total_revenue=0 的 draft,待补价),created_by 记真实登录财务人。
import { bizToday } from '@/lib/biz-date'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(request: Request) {
  // 鉴权:仅登录会话(财务 UI 按钮)。真实登录人记为 created_by(审批留痕,不信任客户端传入 actor)。
  const session = await createClient()
  const { data: sessionUser } = await session.auth.getUser()
  if (!sessionUser?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { syncedOrderId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const syncedOrderId = body.syncedOrderId
  if (!syncedOrderId) {
    return NextResponse.json({ error: '缺少 syncedOrderId' }, { status: 400 })
  }

  try {
    const finance = createServiceClient()

    // 1. 读取该同步订单
    const { data: so, error: soErr } = await finance
      .from('synced_orders')
      .select('id, order_no, style_no, customer_name, currency, total_amount, unit_price, quantity, quantity_unit, budget_order_id, lifecycle_status')
      .eq('id', syncedOrderId)
      .maybeSingle()
    if (soErr) throw new Error(soErr.message)
    if (!so) return NextResponse.json({ error: '订单不存在或未同步' }, { status: 404 })

    // 幂等:已建过预算 → 直接返回
    if (so.budget_order_id) {
      return NextResponse.json({ ok: true, budgetOrderId: so.budget_order_id, already: true })
    }

    // 死单(已取消/删除)不建预算 —— 与 webhook 保守口径一致
    const DEAD = ['cancelled', 'deleted', '已取消', '已删除']
    if (DEAD.includes(String(so.lifecycle_status || ''))) {
      return NextResponse.json({ error: `订单为「${so.lifecycle_status}」,不建预算` }, { status: 409 })
    }

    // 2. 解析客户(串行化的 lookup-or-create RPC,与 sync 路由一致)
    const cleanName = String(so.customer_name || '').trim()
    if (!cleanName) return NextResponse.json({ error: '订单无客户名,无法建预算' }, { status: 422 })
    const { data: cust, error: custErr } = await finance.rpc('get_or_create_customer' as never, {
      p_name: cleanName,
      p_currency: (so.currency as string) || 'USD',
    } as never) as { data: { id?: string } | null; error: { message: string } | null }
    if (custErr || !cust?.id) {
      return NextResponse.json({ error: `客户匹配失败: ${custErr?.message || '无客户'}` }, { status: 422 })
    }

    // 3. 并发复用:若已有同节拍器单号的预算,复用并关联本行(不重复建)
    const { data: linked } = await finance
      .from('synced_orders')
      .select('budget_order_id')
      .eq('order_no', so.order_no)
      .not('budget_order_id', 'is', null)
      .limit(1)
      .maybeSingle()
    if (linked?.budget_order_id) {
      await finance.from('synced_orders').update({ budget_order_id: linked.budget_order_id }).eq('id', so.id)
      return NextResponse.json({ ok: true, budgetOrderId: linked.budget_order_id, reused: true })
    }

    // 4. 建 draft 预算单。金额:优先总额,退回 单价×件数;都无则 0(待财务补价)。
    const totalAmount = Number(so.total_amount) || (Number(so.unit_price || 0) * Number(so.quantity || 0)) || 0
    const cur = (so.currency as string) || 'USD'
    const { data: newBO, error: boErr } = await finance.from('budget_orders').insert({
      order_no: '',
      qimo_order_id: so.id,
      customer_id: cust.id,
      total_revenue: totalAmount,
      currency: cur,
      exchange_rate: cur === 'CNY' ? 1 : null,
      status: 'draft',
      order_date: bizToday(),
      created_by: sessionUser.user.id,   // 真实登录财务人(审批留痕)
      has_sub_documents: false,
      notes: `来源: 新到订单收件箱(财务建单) 节拍器订单号: ${so.order_no} 内部单号: ${so.style_no || ''} 客户: ${cleanName} 数量: ${so.quantity || ''}${so.quantity_unit || '件'}`,
    }).select('id').single()
    if (boErr || !newBO) {
      return NextResponse.json({ error: `预算单创建失败: ${boErr?.message || 'unknown'}` }, { status: 500 })
    }

    // 5. 原子认领 budget_order_id(与 webhook/sync 并发时只允许一张草稿胜出;落败者软删)
    const { data: claim } = await finance.from('synced_orders')
      .update({ budget_order_id: newBO.id })
      .eq('id', so.id).is('budget_order_id', null)
      .select('id')
    if (!claim || claim.length === 0) {
      await finance.from('budget_orders').update({
        deleted_at: new Date().toISOString(), delete_reason: '并发重复草稿自动清理(新到订单建单落败)',
      }).eq('id', newBO.id)
      const { data: winner } = await finance.from('synced_orders').select('budget_order_id').eq('id', so.id).maybeSingle()
      return NextResponse.json({ ok: true, budgetOrderId: winner?.budget_order_id ?? null, reused: true })
    }

    return NextResponse.json({ ok: true, budgetOrderId: newBO.id })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
