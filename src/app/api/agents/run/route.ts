// ============================================================
// POST /api/agents/run — Agent调度API
// 激活所有Agent引擎，结果写入DB + 触发通知
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { generateCollectionList, evaluateCustomerRisk, generateOverdueRiskEvents } from '@/lib/agents/collection-agent'
import { generatePaymentPlan, getWeeklyPaymentSummary } from '@/lib/agents/payment-agent'
import { detectProfitAnomalies, generateProfitRiskEvents } from '@/lib/agents/profit-agent'
import { runCircuitBreakerChecks, generateBreakerActions } from '@/lib/agents/circuit-breaker'
import type { CustomerFinancialProfile } from '@/lib/types/agent'

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const { agent_type } = await request.json() as { agent_type?: string }
    const supabase = await createClient()
    const results: Record<string, unknown> = {}

    // --- 回款Agent ---
    if (!agent_type || agent_type === 'collection') {
      const { data: invoices } = await supabase
        .from('actual_invoices')
        .select('supplier_name, total_amount, currency, invoice_date, invoice_no, budget_order_id, due_date, status')
        .eq('invoice_type', 'customer_statement')
        .in('status', ['pending', 'approved'])

      if (invoices?.length) {
        const collections = generateCollectionList(invoices.map(inv => ({
          customer: inv.supplier_name || '', orderNo: inv.invoice_no,
          amount: inv.total_amount, paid: 0, balance: inv.total_amount,
          currency: inv.currency, dueDate: inv.due_date || inv.invoice_date || '',
        })))

        const riskEvents = generateOverdueRiskEvents(collections)
        if (riskEvents.length) {
          const { error: riskErr } = await supabase.from('financial_risk_events').insert(riskEvents)
          if (riskErr) console.error('风险事件写入失败:', riskErr.message)
        }
        results.collection = { items: collections.length, risks: riskEvents.length }
      } else {
        results.collection = { items: 0, risks: 0 }
      }
    }

    // --- 利润异常Agent ---
    if (!agent_type || agent_type === 'profit') {
      const { data: orders } = await supabase
        .from('budget_orders')
        .select('order_no, total_revenue, total_cost, estimated_margin, estimated_freight, estimated_commission, target_purchase_price, currency, customers(company)')
        .in('status', ['approved', 'closed'])

      if (orders?.length) {
        const anomalies = detectProfitAnomalies(orders.map(o => ({
          order_no: o.order_no, customer: (o.customers as unknown as Record<string,unknown>)?.company as string || '',
          total_revenue: o.total_revenue, total_cost: o.total_cost,
          estimated_margin: o.estimated_margin, estimated_freight: o.estimated_freight,
          estimated_commission: o.estimated_commission, target_purchase_price: o.target_purchase_price,
          currency: o.currency,
        })))

        const riskEvents = generateProfitRiskEvents(anomalies)
        if (riskEvents.length) {
          const { error: riskErr } = await supabase.from('financial_risk_events').insert(riskEvents)
          if (riskErr) console.error('利润风险事件写入失败:', riskErr.message)
        }
        results.profit = { anomalies: anomalies.length, risks: riskEvents.length }
      } else {
        results.profit = { anomalies: 0, risks: 0 }
      }
    }

    // --- 熔断Agent ---
    if (!agent_type || agent_type === 'circuit_breaker') {
      const { data: profiles } = await supabase
        .from('customer_financial_profiles')
        .select('*')

      if (profiles?.length) {
        let totalDecisions = 0
        for (const profile of profiles) {
          const decisions = runCircuitBreakerChecks(profile as CustomerFinancialProfile)
          if (decisions.length) {
            const actions = generateBreakerActions(decisions)
            await supabase.from('financial_agent_actions').insert(actions)
            totalDecisions += decisions.length
          }
        }
        results.circuit_breaker = { customers_checked: profiles.length, decisions: totalDecisions }
      }
    }

    // 记录Agent执行
    await supabase.from('financial_agent_actions').insert({
      action_type: 'auto_risk_detection',
      target_type: 'system',
      target_id: 'batch_scan',
      summary: `Agent扫描完成: ${JSON.stringify(results)}`,
      detail: results as Record<string, unknown>,
      execution_result: 'success',
    })

    return NextResponse.json({ status: 'ok', results })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown' }, { status: 500 })
  }
}
