// ============================================================
// GET /api/profit/orders/[id]
// Full order profit detail: budget fields + style breakdown + recommendations
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  calculateStyleProfit,
  calculateOrderProfitFromBudget,
  simulateExchangeRateImpact,
  classifyMarginRisk,
} from '@/lib/profit-calculator'
import { generateStyleRecommendations, generateFXRecommendation } from '@/lib/profit-recommendation-engine'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { id } = await params

  try {
    const supabase = await createClient()

    // Fetch order
    const { data: order, error: orderErr } = await supabase
      .from('budget_orders')
      .select('*, customers(id, company, country, currency)')
      .eq('id', id)
      .single()

    if (orderErr || !order) {
      return NextResponse.json({ error: '订单不存在' }, { status: 404 })
    }

    // Sales can only view their own
    if (auth.role === 'sales' && order.created_by !== auth.userId) {
      return NextResponse.json({ error: '无权访问此订单' }, { status: 403 })
    }

    // Fetch per-style breakdown
    const { data: styles } = await supabase
      .from('profit_order_styles')
      .select('*')
      .eq('budget_order_id', id)
      .order('created_at')

    // Fetch benchmarks for the categories in this order
    const categories = [...new Set((styles || []).map(s => s.product_category).filter(Boolean))]
    const { data: benchmarks } = await supabase
      .from('profit_cost_benchmarks')
      .select('*')
      .in('product_category', categories.length > 0 ? categories : ['__none__'])

    const benchmarkMap = new Map(
      (benchmarks || []).map(b => [`${b.product_category}|${b.size_type}`, b])
    )

    // Compute per-style profit and recommendations
    const enrichedStyles = (styles || []).map(s => {
      const styleResult = calculateStyleProfit({
        selling_price_per_piece_usd: s.selling_price_per_piece_usd || 0,
        fabric_usage_kg_per_piece: s.fabric_usage_kg_per_piece || 0,
        fabric_price_per_kg_rmb: s.fabric_price_per_kg_rmb || 0,
        cmt_cost_per_piece_rmb: s.cmt_cost_per_piece_rmb || 0,
        trim_cost_per_piece_rmb: s.trim_cost_per_piece_rmb || 0,
        packing_cost_per_piece_rmb: s.packing_cost_per_piece_rmb || 0,
        freight_cost_per_piece_usd: s.freight_cost_per_piece_usd || 0,
        other_cost_per_piece_rmb: s.other_cost_per_piece_rmb || 0,
        exchange_rate: s.exchange_rate || order.exchange_rate || 7,
      })

      const benchmark = benchmarkMap.get(`${s.product_category}|${s.size_type || 'missy'}`)
      const recommendations = generateStyleRecommendations({
        style_no: s.style_no,
        product_category: s.product_category,
        size_type: s.size_type || 'missy',
        selling_price_per_piece_usd: s.selling_price_per_piece_usd || 0,
        fabric_usage_kg_per_piece: s.fabric_usage_kg_per_piece || 0,
        fabric_price_per_kg_rmb: s.fabric_price_per_kg_rmb || 0,
        cmt_cost_per_piece_rmb: s.cmt_cost_per_piece_rmb || 0,
        trim_cost_per_piece_rmb: s.trim_cost_per_piece_rmb || 0,
        packing_cost_per_piece_rmb: s.packing_cost_per_piece_rmb || 0,
        freight_cost_per_piece_usd: s.freight_cost_per_piece_usd || 0,
        other_cost_per_piece_rmb: s.other_cost_per_piece_rmb || 0,
        exchange_rate: s.exchange_rate || order.exchange_rate || 7,
        margin_per_style: styleResult.margin_per_style,
        total_cost_per_piece_usd: styleResult.total_cost_per_piece_usd,
        benchmark,
      })

      return {
        ...s,
        ...styleResult,
        risk_status: classifyMarginRisk(styleResult.margin_per_style),
        recommendations,
      }
    })

    // Order-level profit (from budget fields or styles)
    const orderRate = order.exchange_rate || 7
    const budgetProfit = calculateOrderProfitFromBudget(
      order.total_revenue || 0,
      order.total_cost || 0,
      orderRate,
      order.currency || 'USD'
    )

    // FX simulation
    const fxScenarios = simulateExchangeRateImpact({
      totalRevenueUsd: budgetProfit.sales_amount_usd,
      totalCostRmb: order.total_cost || 0,
      lockedRate: orderRate,
    })

    // FX recommendation
    const CURRENT_RATE = orderRate // In production, fetch live rate
    const currentProfit = calculateOrderProfitFromBudget(
      order.total_revenue || 0,
      order.total_cost || 0,
      CURRENT_RATE,
      order.currency || 'USD'
    )
    const fxRec = generateFXRecommendation({
      currentRate: CURRENT_RATE,
      lockedRate: orderRate,
      currentMargin: currentProfit.gross_margin,
      lockedMargin: budgetProfit.gross_margin,
    })

    // Collect all recommendations
    const allRecs = [
      ...(fxRec ? [fxRec] : []),
      ...enrichedStyles.flatMap(s => s.recommendations),
    ].sort((a, b) => a.priority - b.priority)

    return NextResponse.json({
      order: {
        ...order,
        customer: order.customers,
        computed_profit: budgetProfit,
        risk_status: classifyMarginRisk(budgetProfit.gross_margin),
      },
      styles: enrichedStyles,
      fx_scenarios: fxScenarios,
      recommendations: allRecs,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
