// ============================================================
// GET /api/profit/orders
// Returns budget_orders with computed profit metrics
// Requires: auth (finance_manager/admin see all, sales see own)
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { calculateOrderProfitFromBudget, classifyMarginRisk } from '@/lib/profit-calculator'

export async function GET(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { searchParams } = request.nextUrl
  const customerId = searchParams.get('customer_id')
  const riskFilter = searchParams.get('risk')       // critical | warning | healthy
  const search = searchParams.get('search') || ''
  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Math.min(parseInt(limitParam), 500) : 200

  try {
    const supabase = await createClient()

    let query = supabase
      .from('budget_orders')
      .select('id, order_no, customer_id, order_date, delivery_date, total_revenue, total_cost, estimated_profit, estimated_margin, currency, exchange_rate, status, notes, customers(id, company, country, currency)')
      .in('status', ['approved', 'closed', 'pending_review', 'draft'])
      .order('order_date', { ascending: false })
      .limit(limit)

    // Sales can only see their own orders
    const isSales = auth.role === 'sales'
    if (isSales) {
      query = query.eq('created_by', auth.userId!)
    }

    if (customerId) query = query.eq('customer_id', customerId)
    if (search) query = query.ilike('order_no', `%${search}%`)

    const { data: orders, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Enrich with computed profit metrics
    const enriched = (orders || []).map(order => {
      const profit = calculateOrderProfitFromBudget(
        order.total_revenue || 0,
        order.total_cost || 0,
        order.exchange_rate || 7,
        order.currency || 'USD'
      )
      const risk = classifyMarginRisk(profit.gross_margin)
      return {
        ...order,
        computed_profit_usd: profit.gross_profit_usd,
        computed_margin: profit.gross_margin,
        computed_cost_usd: profit.total_cost_usd,
        computed_sales_usd: profit.sales_amount_usd,
        risk_status: risk,
        customer: order.customers,
      }
    })

    // Apply risk filter (client-side since it's computed)
    const filtered = riskFilter
      ? enriched.filter(o => o.risk_status === riskFilter)
      : enriched

    // Summary stats
    const totalSales = filtered.reduce((s, o) => s + o.computed_sales_usd, 0)
    const totalProfit = filtered.reduce((s, o) => s + o.computed_profit_usd, 0)
    const avgMargin = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0

    return NextResponse.json({
      orders: filtered,
      summary: {
        count: filtered.length,
        total_sales_usd: Math.round(totalSales * 100) / 100,
        total_profit_usd: Math.round(totalProfit * 100) / 100,
        avg_margin: Math.round(avgMargin * 100) / 100,
        critical_count: filtered.filter(o => o.risk_status === 'critical').length,
        warning_count: filtered.filter(o => o.risk_status === 'warning').length,
        healthy_count: filtered.filter(o => o.risk_status === 'healthy').length,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
