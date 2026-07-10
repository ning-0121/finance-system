// ============================================================
// 老板驾驶舱数据（全部真实，可追源；不再有估算公式）
// 复用月结面板(getMonthlyClosingPanel)算本月经营数；现金取银行账户真实余额。
// ============================================================
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { createClient } from '@/lib/supabase/server'
import { getMonthlyClosingPanel } from '@/lib/engines/closing-engine'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { bizToday } from '@/lib/biz-date'
import { safeRate } from '@/lib/accounting/utils'

export const dynamic = 'force-dynamic'

const r2 = (n: number) => Math.round(n * 100) / 100
const cnyRate = (c: string | null, r: number | null) => (c || 'CNY') === 'CNY' ? 1 : (Number(r) || 1)

export async function GET() {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  try {
    const supabase = await createClient()
    const today = bizToday()
    const period = today.slice(0, 7)

    // 本月经营面板（与月结同口径）
    const panel = await getMonthlyClosingPanel(period)

    // 现金余额：银行账户真实余额合计（#5 银行对账上锚）；无账户则 null（不估算）
    const { data: accts } = await supabase.from('bank_accounts').select('current_balance').eq('is_active', true)
    const hasBank = (accts || []).length > 0
    const cashBalance = hasBank ? r2((accts || []).reduce((s, a) => s + (Number(a.current_balance) || 0), 0)) : null

    // 今日回款 / 今日付款 —— 用中国时区的当日边界（received_at 是 timestamptz，
    // 若按裸 UTC 边界会把北京时间凌晨的收付款算到昨天）
    const dayStart = `${today}T00:00:00+08:00`
    const dayEnd = `${today}T23:59:59+08:00`
    const [{ data: todayRec }, { data: todayPay }] = await Promise.all([
      supabase.from('receivable_payments').select('amount_cny').is('voided_at', null).gte('received_at', dayStart).lte('received_at', dayEnd),
      supabase.from('supplier_payments').select('amount').is('deleted_at', null).gte('paid_at', dayStart).lte('paid_at', dayEnd),
    ])
    const todayIn = r2((todayRec || []).reduce((s, p) => s + (Number(p.amount_cny) || 0), 0))
    const todayOut = r2((todayPay || []).reduce((s, p) => s + (Number(p.amount) || 0), 0))

    // 本周必付：应付到期日在未来 7 天内、未付。外币按所属订单汇率折人民币（payable_records 无汇率列）
    const in7 = new Date(new Date(today).getTime() + 7 * 86400000).toISOString().slice(0, 10)
    const [{ data: duePay }, { data: rateOrders }] = await Promise.all([
      fetchAll<Record<string, unknown>>((from, to) => supabase.from('payable_records')
        .select('supplier_name, amount, currency, exchange_rate, due_date, budget_order_id')
        .in('payment_status', ['unpaid', 'pending_approval', 'approved']).not('due_date', 'is', null)
        .lte('due_date', in7).order('due_date').order('id', { ascending: true }).range(from, to)),
      fetchAll<Record<string, unknown>>((from, to) => supabase.from('budget_orders')
        .select('id, currency, exchange_rate').is('deleted_at', null).order('id', { ascending: true }).range(from, to)),
    ])
    const ordRate = new Map<string, number>()
    // P0-3:缺汇率不再按 0(会把美金应付显示为 ¥0、漏掉真实到期款)。统一走 safeRate(缺则告警+按7)。
    ;(rateOrders || []).forEach(o => ordRate.set(o.id as string, safeRate(Number(o.exchange_rate), o.currency as string, '本周必付-订单汇率')))
    const weekPayables = (duePay || []).map(p => {
      const cur = (p.currency as string) || 'CNY'
      // P0-3b:优先用 payable_records 自带的权威汇率(触发器/回填已填);缺则退回订单汇率,再退 safeRate
      const rate = p.exchange_rate != null
        ? Number(p.exchange_rate)
        : (ordRate.get(p.budget_order_id as string) ?? safeRate(null, cur, '本周必付'))
      return { supplier: p.supplier_name as string, amount: r2((Number(p.amount) || 0) * rate), due: p.due_date as string }
    })
    const weekPayCny = r2(weekPayables.reduce((s, p) => s + p.amount, 0))

    // 风险订单：毛利率 < 10%（含负毛利）；分页取全量 + 仅已审批/已关闭（与口径一致）
    const { data: orders } = await fetchAll<Record<string, unknown>>((from, to) => supabase.from('budget_orders')
      .select('order_no, estimated_margin, customer:customers(company)').is('deleted_at', null)
      .in('status', ['approved', 'closed']).order('id', { ascending: true }).range(from, to))
    const riskOrders = (orders || [])
      .filter(o => (Number(o.estimated_margin) ?? 100) < 10)
      .map(o => ({ orderNo: o.order_no as string, customer: (o.customer as unknown as { company?: string })?.company || '', margin: Number(o.estimated_margin) || 0 }))
      .sort((a, b) => a.margin - b.margin).slice(0, 8)
    const lossCount = riskOrders.filter(o => o.margin < 0).length

    // 风险客户 + 逾期应收：取自异常中心 open 的 overdue_collection（同口径，不另算）
    const { data: overdue } = await supabase.from('audit_findings')
      .select('entity_id, title, evidence').eq('finding_type', 'overdue_collection').eq('status', 'open')
    const custMap = new Map<string, { name: string; amountCny: number; maxDays: number }>()
    for (const f of overdue || []) {
      const ev = (f.evidence as Record<string, unknown>) || {}
      const name = String(ev.customer || '未知客户')
      const amt = Number(ev.amountCny) || 0
      const days = Number(ev.daysOutstanding) || 0
      const cur = custMap.get(name) || { name, amountCny: 0, maxDays: 0 }
      cur.amountCny = r2(cur.amountCny + amt); cur.maxDays = Math.max(cur.maxDays, days)
      custMap.set(name, cur)
    }
    const riskCustomers = [...custMap.values()].sort((a, b) => b.amountCny - a.amountCny).slice(0, 8)
    const overdueArCny = r2(riskCustomers.reduce((s, c) => s + c.amountCny, 0))

    return NextResponse.json({
      asOf: today,
      cash: { balance: cashBalance, hasBank, todayIn, todayOut },
      panel,  // revenueCny/costCny/profitCny/marginPct/arBalanceCny/apBalanceCny/collectedCny/collectionRatePct/orderCount/settled
      overdue: { arCny: overdueArCny, customers: riskCustomers, count: riskCustomers.length, maxDays: riskCustomers.reduce((m, c) => Math.max(m, c.maxDays), 0) },
      weekPayables: { totalCny: weekPayCny, list: weekPayables.slice(0, 8), count: weekPayables.length },
      riskOrders: { list: riskOrders, count: riskOrders.length, lossCount },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '加载失败' }, { status: 500 })
  }
}
