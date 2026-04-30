// ============================================================
// POST /api/profit/orders/[id]/recompute-budget
// 用 profit_order_styles 的数据重算预算单 total_cost / revenue / profit / margin
// 让"利润控制中心"录入的款式数据自动反哺预算单，避免双轨录入。
//
// 计算口径：
//   total_revenue_usd = Σ qty × selling_price_per_piece_usd          (USD)
//   total_cost_rmb    = Σ qty × ( RMB成本/件 ) + qty × freight$ × FX  (RMB)
//   profit_usd        = revenue_usd − cost_rmb / FX
//   margin            = profit / revenue × 100
//
// 写回 budget_orders:
//   - total_revenue:     若 currency=USD 则直接写USD；其它币种 ×FX 写本币
//   - total_cost:        固定 RMB（与现有口径一致）
//   - estimated_profit:  以 USD 计
//   - estimated_margin:  百分比
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import Decimal from 'decimal.js'

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

interface StyleRow {
  qty: number | null
  selling_price_per_piece_usd: number | null
  fabric_usage_kg_per_piece: number | null
  fabric_price_per_kg_rmb: number | null
  cmt_cost_per_piece_rmb: number | null
  trim_cost_per_piece_rmb: number | null
  packing_cost_per_piece_rmb: number | null
  freight_cost_per_piece_usd: number | null
  other_cost_per_piece_rmb: number | null
  exchange_rate: number | null
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && isFinite(v) ? v : 0
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  // Sales 不能改预算成本
  if (!['admin', 'finance_manager', 'finance_staff'].includes(auth.role || '')) {
    return NextResponse.json({ error: '无权重算预算（需要财务或管理员角色）' }, { status: 403 })
  }

  const { id } = await params
  const { searchParams } = request.nextUrl
  const dryRun = searchParams.get('dry_run') === 'true'

  try {
    const supabase = await createClient()

    // 1. 拉订单
    const { data: order, error: orderErr } = await supabase
      .from('budget_orders')
      .select('id, order_no, status, currency, exchange_rate, total_revenue, total_cost, estimated_profit, estimated_margin, notes')
      .eq('id', id)
      .single()

    if (orderErr || !order) {
      return NextResponse.json({ error: '订单不存在' }, { status: 404 })
    }

    // 已关账订单不允许重算
    if (order.status === 'closed') {
      return NextResponse.json(
        { error: '订单已关账，预算成本无法再重算。如需调整，请通过决算流程。' },
        { status: 409 }
      )
    }

    // 2. 拉所有款式
    const { data: stylesRaw, error: styleErr } = await supabase
      .from('profit_order_styles')
      .select('qty, selling_price_per_piece_usd, fabric_usage_kg_per_piece, fabric_price_per_kg_rmb, cmt_cost_per_piece_rmb, trim_cost_per_piece_rmb, packing_cost_per_piece_rmb, freight_cost_per_piece_usd, other_cost_per_piece_rmb, exchange_rate')
      .eq('budget_order_id', id)

    if (styleErr) {
      return NextResponse.json({ error: `读取款式数据失败: ${styleErr.message}` }, { status: 500 })
    }

    const styles = (stylesRaw || []) as StyleRow[]
    if (styles.length === 0) {
      return NextResponse.json(
        { error: '该订单还没有任何款式成本数据，请先在利润控制中心录入或批量导入款式后再重算。' },
        { status: 400 }
      )
    }

    // 3. 聚合
    const orderRate = num(order.exchange_rate) || 7
    let totalQty = 0
    let totalRevenueUsd = new Decimal(0)
    let totalCostRmb = new Decimal(0)

    for (const s of styles) {
      const qty = num(s.qty)
      if (qty <= 0) continue
      totalQty += qty

      const styleRate = num(s.exchange_rate) || orderRate

      // Revenue (USD)
      const sellPriceUsd = num(s.selling_price_per_piece_usd)
      totalRevenueUsd = totalRevenueUsd.plus(new Decimal(qty).mul(sellPriceUsd))

      // Cost in RMB-equivalent for this style
      const fabricRmb = new Decimal(num(s.fabric_usage_kg_per_piece)).mul(num(s.fabric_price_per_kg_rmb))
      const rmbPerPiece = fabricRmb
        .plus(num(s.cmt_cost_per_piece_rmb))
        .plus(num(s.trim_cost_per_piece_rmb))
        .plus(num(s.packing_cost_per_piece_rmb))
        .plus(num(s.other_cost_per_piece_rmb))

      // Convert per-piece USD freight back to RMB at the style's rate
      const freightRmbPerPiece = new Decimal(num(s.freight_cost_per_piece_usd)).mul(styleRate)

      const styleCostRmb = new Decimal(qty).mul(rmbPerPiece.plus(freightRmbPerPiece))
      totalCostRmb = totalCostRmb.plus(styleCostRmb)
    }

    // 4. 计算最终写入字段
    const revenueUsd = totalRevenueUsd.toDecimalPlaces(2).toNumber()
    const costRmb = totalCostRmb.toDecimalPlaces(2).toNumber()

    // total_revenue 的目标币种 = order.currency
    const targetRevenue = (order.currency || 'USD') === 'USD'
      ? revenueUsd
      : new Decimal(revenueUsd).mul(orderRate).toDecimalPlaces(2).toNumber()

    // estimated_profit 用 USD 计算（与利润中心展示一致）
    const profitUsd = new Decimal(revenueUsd).minus(new Decimal(costRmb).div(orderRate)).toDecimalPlaces(2).toNumber()
    const margin = revenueUsd > 0
      ? new Decimal(profitUsd).div(revenueUsd).mul(100).toDecimalPlaces(2).toNumber()
      : 0

    const before = {
      total_revenue: num(order.total_revenue),
      total_cost: num(order.total_cost),
      estimated_profit: num(order.estimated_profit),
      estimated_margin: num(order.estimated_margin),
    }
    const after = {
      total_revenue: targetRevenue,
      total_cost: costRmb,
      estimated_profit: profitUsd,
      estimated_margin: margin,
    }

    const summary = {
      style_count: styles.length,
      total_qty: totalQty,
      currency: order.currency || 'USD',
      exchange_rate: orderRate,
      total_revenue_usd: revenueUsd,
      total_cost_rmb: costRmb,
      gross_profit_usd: profitUsd,
      gross_margin: margin,
    }

    // dry_run：只返回计算结果，不写库
    if (dryRun) {
      return NextResponse.json({ dry_run: true, before, after, summary, status: order.status })
    }

    // approved 状态写回时返回 warning 提示
    const warnings: string[] = []
    if (order.status === 'approved') {
      warnings.push('订单已审批通过，本次重算将覆盖已审批的预算成本数据')
    }

    // 5. 写库
    const auditLine = `[${new Date().toISOString()}] 利润中心款式重算 by ${auth.role}: ` +
      `cost ¥${before.total_cost.toFixed(2)} → ¥${after.total_cost.toFixed(2)} · ` +
      `margin ${before.estimated_margin.toFixed(2)}% → ${after.estimated_margin.toFixed(2)}%`
    const newNotes = order.notes ? `${order.notes}\n${auditLine}` : auditLine

    const { error: updateErr } = await supabase
      .from('budget_orders')
      .update({
        total_revenue: targetRevenue,
        total_cost: costRmb,
        estimated_profit: profitUsd,
        estimated_margin: margin,
        notes: newNotes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateErr) {
      return NextResponse.json({ error: `写入失败: ${updateErr.message}` }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      before,
      after,
      summary,
      warnings,
      status: order.status,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Server error' },
      { status: 500 }
    )
  }
}
