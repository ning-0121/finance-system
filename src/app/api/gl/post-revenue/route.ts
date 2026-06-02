// ============================================================
// POST /api/gl/post-revenue  { orderId }
// 订单审批通过后确认收入凭证（借 应收账款 / 贷 主营业务收入）。
// 幂等：postRevenueRecognition 内部按 (budget_order, orderId) 自检，重复调用不重记。
// 设计：非阻塞——审批动作已先行成功，本路由失败只影响 GL，不影响业务数据。
// ============================================================
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { postRevenueRecognition } from '@/lib/accounting/gl-posting'
import type { BudgetOrder } from '@/lib/types'

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const { orderId } = await request.json()
    if (!orderId) return NextResponse.json({ error: '缺少 orderId' }, { status: 400 })

    const supabase = await createClient()
    const { data: row, error } = await supabase
      .from('budget_orders')
      .select('id, order_no, currency, exchange_rate, total_revenue, order_date, status, customer_id, customers(company)')
      .eq('id', orderId)
      .single()
    if (error || !row) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
    if (row.status !== 'approved' && row.status !== 'closed') {
      return NextResponse.json({ error: `订单状态 ${row.status} 不确认收入（仅 approved/closed）` }, { status: 409 })
    }

    const cust = row.customers as unknown as { company?: string } | null
    const order = {
      id: row.id as string,
      order_no: row.order_no as string,
      currency: (row.currency as string) || 'CNY',
      exchange_rate: row.exchange_rate as number,
      total_revenue: row.total_revenue as number,
      order_date: row.order_date as string,
      customer_id: row.customer_id as string,
      customer: { company: cust?.company || '' },
    } as unknown as BudgetOrder

    const result = await postRevenueRecognition(order)
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '过账失败' }, { status: 500 })
  }
}
