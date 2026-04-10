// ============================================================
// POST /api/integration/financial-check
// 节拍器调用：下单前/采购前/出货前 财务检查
// 安全：API Key + 签名验证
// ============================================================

import { NextResponse } from 'next/server'
import { validateRequest, checkRateLimit } from '@/lib/integration/security'
import { preOrderFinancialCheck, preShipmentFinancialCheck } from '@/lib/agents/financial-check'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  // 速率限制
  const clientIp = request.headers.get('x-forwarded-for') || 'unknown'
  if (!checkRateLimit(clientIp, 60, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  // 安全验证
  const validation = await validateRequest(request)
  if (!validation.valid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = JSON.parse(validation.body!)
    const { check_type, customer_name, order_amount, estimated_profit_rate, paid_amount, required_payment_ratio, currency } = body

    if (!check_type || !customer_name) {
      return NextResponse.json({ error: 'Missing check_type or customer_name' }, { status: 400 })
    }

    // 从数据库获取客户画像
    const supabase = await createClient()
    const { data: profile } = await supabase
      .from('customer_financial_profiles')
      .select('*')
      .eq('customer_name', customer_name)
      .single()

    const customerProfile = profile || {
      risk_level: 'B',
      total_outstanding: 0,
      credit_limit: 100000,
      overdue_rate: 0,
      dependency_score: 0,
      avg_payment_days: 30,
    }

    let result
    if (check_type === 'pre_order') {
      result = preOrderFinancialCheck({
        customer: customerProfile,
        orderAmount: order_amount || 0,
        estimatedProfitRate: estimated_profit_rate || 15,
        currency: currency || 'USD',
      })
    } else if (check_type === 'pre_shipment') {
      // 检查是否有逾期订单
      const { data: overdueOrders } = await supabase
        .from('actual_invoices')
        .select('id')
        .eq('supplier_name', customer_name)
        .eq('status', 'pending')
        .lt('due_date', new Date().toISOString().split('T')[0])
        .limit(1)

      result = preShipmentFinancialCheck({
        customer: customerProfile,
        orderAmount: order_amount || 0,
        paidAmount: paid_amount || 0,
        requiredPaymentRatio: required_payment_ratio || 0.3,
        hasOverdueOrders: (overdueOrders?.length || 0) > 0,
      })
    } else {
      return NextResponse.json({ error: 'Invalid check_type. Use: pre_order, pre_shipment' }, { status: 400 })
    }

    // 记录Agent动作
    await supabase.from('financial_agent_actions').insert({
      action_type: 'auto_risk_detection',
      target_type: 'customer',
      target_id: customer_name,
      summary: `${check_type}: ${result.summary}`,
      detail: { check_type, customer_name, result },
      execution_result: 'success',
    })

    return NextResponse.json({
      status: 'ok',
      check_type,
      customer_name,
      ...result,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
