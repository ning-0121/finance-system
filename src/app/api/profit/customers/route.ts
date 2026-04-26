// ============================================================
// GET /api/profit/customers
// Customer-level profit analysis: avg margin, grade, recommendation
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { calculateOrderProfitFromBudget, gradeCustomer } from '@/lib/profit-calculator'
import { generateCustomerRecommendation } from '@/lib/profit-recommendation-engine'

export async function GET() {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  // Sales cannot view customer profit ranking
  if (auth.role === 'sales') {
    return NextResponse.json({ error: '销售角色无权查看客户利润排名' }, { status: 403 })
  }

  try {
    const supabase = await createClient()

    const { data: orders, error } = await supabase
      .from('budget_orders')
      .select('customer_id, total_revenue, total_cost, currency, exchange_rate, status, customers(id, company, country, currency)')
      .in('status', ['approved', 'closed'])
      .order('order_date', { ascending: false })
      .limit(1000)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Group by customer
    const customerMap = new Map<string, {
      id: string
      company: string
      country: string | null
      orders: Array<{ salesUsd: number; profitUsd: number; marginPct: number }>
    }>()

    for (const order of (orders || [])) {
      const cust = order.customers as unknown as { id: string; company: string; country: string | null } | null
      if (!cust) continue

      const profit = calculateOrderProfitFromBudget(
        order.total_revenue || 0,
        order.total_cost || 0,
        order.exchange_rate || 7,
        order.currency || 'USD'
      )

      const existing = customerMap.get(cust.id) || {
        id: cust.id,
        company: cust.company,
        country: cust.country,
        orders: [],
      }
      existing.orders.push({
        salesUsd: profit.sales_amount_usd,
        profitUsd: profit.gross_profit_usd,
        marginPct: profit.gross_margin,
      })
      customerMap.set(cust.id, existing)
    }

    // Compute per-customer stats
    const customers = Array.from(customerMap.values()).map(c => {
      const totalSales = c.orders.reduce((s, o) => s + o.salesUsd, 0)
      const totalProfit = c.orders.reduce((s, o) => s + o.profitUsd, 0)
      const avgMargin = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0

      // Mock payment terms (would come from actual payment data)
      // In production: join with budget_orders.notes or a dedicated field
      const avgPaymentDays = 45  // placeholder; replace with real data

      const grade = gradeCustomer(avgMargin, avgPaymentDays)
      const recommendation = generateCustomerRecommendation({
        customerName: c.company,
        avgMargin,
        avgPaymentDays,
        orderCount: c.orders.length,
        grade,
      })

      return {
        customer_id: c.id,
        customer_name: c.company,
        country: c.country,
        order_count: c.orders.length,
        total_sales_usd: Math.round(totalSales * 100) / 100,
        total_profit_usd: Math.round(totalProfit * 100) / 100,
        avg_margin: Math.round(avgMargin * 100) / 100,
        avg_payment_days: avgPaymentDays,
        grade,
        recommendation,
      }
    }).sort((a, b) => b.total_sales_usd - a.total_sales_usd)

    const summary = {
      total_customers: customers.length,
      grade_a: customers.filter(c => c.grade === 'A').length,
      grade_b: customers.filter(c => c.grade === 'B').length,
      grade_c: customers.filter(c => c.grade === 'C').length,
      grade_d: customers.filter(c => c.grade === 'D').length,
      avg_margin: customers.length > 0
        ? Math.round(customers.reduce((s, c) => s + c.avg_margin, 0) / customers.length * 100) / 100
        : 0,
    }

    return NextResponse.json({ customers, summary })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
