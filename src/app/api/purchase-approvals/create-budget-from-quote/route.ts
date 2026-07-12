// POST /api/purchase-approvals/create-budget-from-quote
// PO 审批环节:财务基于「内部报价单识别结果 + 手工调价」生成预算单草稿。
// 铁律合规:AI 识别只是建议;本接口只由财务在 UI 调整确认后点击触发,
// created_by 记真实 auth.uid(),预算走既有 draft→pending_review→approved 审批流。
// 结构对齐 /orders/budget/new:成本行内联 items[0]._cost_breakdown.lines(采购审批页预算对照直接可读)。
import { bizToday } from '@/lib/biz-date'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { QUOTE_BUCKETS, type QuoteBucket } from '@/lib/document-engine/quote-extractor'

interface InLine { bucket: string; name: string; supplier?: string | null; qty?: number | null; unit?: string | null; unit_price?: number | null; amount: number }

const r2 = (n: number) => Math.round(n * 100) / 100

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const roleErr = requireRole(auth, ['finance_staff', 'finance_manager', 'admin'])
  if (roleErr) return roleErr

  let body: {
    syncedOrderId?: string
    revenue?: number; currency?: string; exchangeRate?: number | null
    quantity?: number | null; unit?: string | null
    costLines?: InLine[]
    sourceDocumentId?: string | null   // 报价单文档 id(溯源)
    purchaseOrderId?: string | null    // 触发本次建单的采购单(溯源)
    notes?: string
  }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  const { syncedOrderId } = body
  if (!syncedOrderId) return NextResponse.json({ error: '缺少 syncedOrderId' }, { status: 400 })
  const costLines = (body.costLines || []).filter(l => l && l.name && Number(l.amount) > 0)
  if (costLines.length === 0) return NextResponse.json({ error: '至少需要一条有效成本行(金额>0)' }, { status: 400 })

  try {
    const session = await createClient()
    const { data: sessionUser } = await session.auth.getUser()
    const uid = sessionUser?.user?.id
    if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const finance = createServiceClient()

    // 1. 读同步订单(幂等/死单口径与 create-budget 一致)
    const { data: so, error: soErr } = await finance.from('synced_orders')
      .select('id, order_no, style_no, customer_name, currency, total_amount, unit_price, quantity, quantity_unit, budget_order_id, lifecycle_status')
      .eq('id', syncedOrderId).maybeSingle()
    if (soErr) throw new Error(soErr.message)
    if (!so) return NextResponse.json({ error: '订单不存在或未同步' }, { status: 404 })
    if (so.budget_order_id) return NextResponse.json({ ok: true, budgetOrderId: so.budget_order_id, already: true })
    const DEAD = ['cancelled', 'deleted', '已取消', '已删除']
    if (DEAD.includes(String(so.lifecycle_status || ''))) {
      return NextResponse.json({ error: `订单为「${so.lifecycle_status}」,不建预算` }, { status: 409 })
    }

    // 2. 解析客户
    const cleanName = String(so.customer_name || '').trim()
    if (!cleanName) return NextResponse.json({ error: '订单无客户名,无法建预算' }, { status: 422 })
    const { data: cust, error: custErr } = await finance.rpc('get_or_create_customer' as never, {
      p_name: cleanName, p_currency: (body.currency || so.currency || 'USD') as string,
    } as never) as { data: { id?: string } | null; error: { message: string } | null }
    if (custErr || !cust?.id) return NextResponse.json({ error: `客户匹配失败: ${custErr?.message || '无客户'}` }, { status: 422 })

    // 3. 组装成本(人民币)与利润口径。
    //    ⚠ 关键(审计P1.16修复):_cost_breakdown 必须用【canonical 桶键】+【桶标量】,否则
    //    预算总表/对照(budgetBucketsFromOrder 读 cb.fabric 等标量)全读 0,且订单编辑页只认这6键的
    //    lines,一保存 freight/commission/customs/other 的成本直接蒸发。
    //    报价桶(7种) → 预算canonical桶(6种)映射:commission/other 归 物流/其他(logistics),名字保在行里。
    const QUOTE_TO_CANON: Record<QuoteBucket, string> = {
      fabric: 'fabric', accessory: 'accessory', processing: 'processing',
      freight: 'forwarder', customs: 'container', commission: 'logistics', other: 'logistics',
    }
    const lines: Record<string, InLine[]> = {}
    const scalar: Record<string, number> = { fabric: 0, accessory: 0, processing: 0, forwarder: 0, container: 0, logistics: 0 }
    for (const l of costLines) {
      const qb = (QUOTE_BUCKETS as readonly string[]).includes(l.bucket) ? l.bucket as QuoteBucket : 'other'
      const key = QUOTE_TO_CANON[qb]
      const amt = r2(Number(l.amount) || 0)
      const row: InLine = {
        bucket: key, name: String(l.name).trim(), supplier: l.supplier?.trim() || null,
        qty: l.qty != null ? Number(l.qty) : null, unit: l.unit || null,
        unit_price: l.unit_price != null ? Number(l.unit_price) : null,
        amount: amt,
      }
      if (!lines[key]) lines[key] = []
      lines[key].push(row)
      scalar[key] = r2(scalar[key] + amt)   // 桶标量=该桶 lines 之和(不变量)
    }
    const totalCost = r2(costLines.reduce((s, l) => s + (Number(l.amount) || 0), 0))
    const currency = (body.currency || so.currency || 'USD') as string
    const revenue = r2(Number(body.revenue) || Number(so.total_amount) || 0)
    const rate = currency === 'CNY' ? 1 : (body.exchangeRate != null ? Number(body.exchangeRate) : null)
    const revenueCny = rate != null ? r2(revenue * rate) : null
    const profit = revenueCny != null ? r2(revenueCny - totalCost) : null
    const margin = profit != null && revenueCny ? r2((profit / revenueCny) * 100) : null
    const quantity = body.quantity != null ? Number(body.quantity) : (Number(so.quantity) || null)

    const items = [{
      product_name: so.style_no || so.order_no || '',
      quantity, unit: body.unit || so.quantity_unit || '件',
      unit_price: quantity ? r2(revenue / quantity) : null,
      total: revenue,
      _cost_breakdown: {
        ...scalar,                                        // 六桶标量(canonical键)——预算表/对照/编辑页都读这个
        extras: [],
        lines,
        total_cost: totalCost,
        _currency: 'CNY', _revenue_input: revenue, _revenue_currency: currency, _rate: rate,
        source: 'internal_quote',                         // 溯源:来自报价单识别+财务调价
        source_document_id: body.sourceDocumentId || null,
        purchase_order_id: body.purchaseOrderId || null,
      },
    }]

    // 4. 建 draft 预算单(真实登录财务人)
    const { data: newBO, error: boErr } = await finance.from('budget_orders').insert({
      order_no: '',
      qimo_order_id: so.id,
      customer_id: cust.id,
      items,
      total_revenue: revenue,
      total_cost: totalCost,
      estimated_profit: profit,
      estimated_margin: margin,
      currency,
      exchange_rate: rate,
      status: 'draft',
      order_date: bizToday(),
      created_by: uid,
      has_sub_documents: false,
      notes: [
        `来源: PO审批·报价单识别建预算(财务调价确认)`,
        `节拍器订单号: ${so.order_no}`, `内部单号: ${so.style_no || ''}`,
        body.purchaseOrderId ? `触发采购单: ${body.purchaseOrderId}` : '',
        body.sourceDocumentId ? `报价单文档: ${body.sourceDocumentId}` : '',
        body.notes || '',
      ].filter(Boolean).join(' '),
    }).select('id').single()
    if (boErr || !newBO) return NextResponse.json({ error: `预算单创建失败: ${boErr?.message || 'unknown'}` }, { status: 500 })

    // 5. 原子认领(并发落败者软删,与 create-budget 一致)
    const { data: claim } = await finance.from('synced_orders')
      .update({ budget_order_id: newBO.id })
      .eq('id', so.id).is('budget_order_id', null)
      .select('id')
    if (!claim || claim.length === 0) {
      await finance.from('budget_orders').update({
        deleted_at: new Date().toISOString(), delete_reason: '并发重复草稿自动清理(报价单建预算落败)',
      }).eq('id', newBO.id)
      const { data: winner } = await finance.from('synced_orders').select('budget_order_id').eq('id', so.id).maybeSingle()
      return NextResponse.json({ ok: true, budgetOrderId: winner?.budget_order_id ?? null, reused: true })
    }

    return NextResponse.json({ ok: true, budgetOrderId: newBO.id, totalCost, profit, margin })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 })
  }
}
