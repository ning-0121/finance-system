// ============================================================
// POST /api/orders/[id]/settlement — 确认订单决算单
// 将决算单从 draft → confirmed，并自动生成应付记录
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { notifyPaymentReminder } from '@/lib/wecom/notifications'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { id: budgetOrderId } = await params

  try {
    const supabase = await createClient()

    // 1. 获取决算单（确认存在 + 状态检查）
    const { data: settlement, error: fetchErr } = await supabase
      .from('order_settlements')
      .select('id, status, total_actual, budget_order_id')
      .eq('budget_order_id', budgetOrderId)
      .single()

    if (fetchErr || !settlement) {
      return NextResponse.json({ error: '决算单不存在，请先生成决算单' }, { status: 404 })
    }
    if (settlement.status === 'confirmed' || settlement.status === 'locked') {
      return NextResponse.json({ error: '决算单已确认，请勿重复操作' }, { status: 409 })
    }

    // 2. 获取订单信息（用于通知）
    const { data: order } = await supabase
      .from('budget_orders')
      .select('order_no, supplier_financial_profiles(supplier_name)')
      .eq('id', budgetOrderId)
      .single()

    // 3. 将决算单状态更新为 confirmed（乐观锁：仅更新 draft 状态）
    const { data: updated, error: updateErr } = await supabase
      .from('order_settlements')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', settlement.id)
      .eq('status', 'draft')
      .select('id')

    if (updateErr) {
      return NextResponse.json({ error: `确认失败: ${updateErr.message}` }, { status: 500 })
    }
    if (!updated?.length) {
      return NextResponse.json({ error: '决算单已被其他操作处理' }, { status: 409 })
    }

    // 4. 自动生成应付记录（从发票生成）
    const { data: invoices } = await supabase
      .from('actual_invoices')
      .select('id, invoice_no, supplier_name, invoice_type, total_amount, currency, due_date, status, sub_document_id')
      .eq('budget_order_id', budgetOrderId)
      .in('status', ['approved', 'pending'])

    let payablesCreated = 0
    if (invoices?.length) {
      // 获取预算子单据金额（用于超支判断）
      const { data: subDocs } = await supabase
        .from('budget_sub_documents')
        .select('id, estimated_total')
        .eq('budget_order_id', budgetOrderId)

      const subDocMap = new Map<string, number>()
      subDocs?.forEach(d => subDocMap.set(d.id, d.estimated_total || 0))

      // 获取已有应付记录（防重复）
      const { data: existing } = await supabase
        .from('payable_records')
        .select('invoice_id')
        .eq('budget_order_id', budgetOrderId)

      const existingInvoiceIds = new Set((existing || []).map(e => e.invoice_id))

      const invoiceTypeToCostCategory: Record<string, string> = {
        purchase_order: 'raw_material', supplier_invoice: 'raw_material',
        factory_contract: 'factory', factory_statement: 'factory',
        freight_bill: 'freight', commission_bill: 'commission',
        tax_invoice: 'tax', other_invoice: 'other',
      }

      for (const inv of invoices) {
        if (existingInvoiceIds.has(inv.id)) continue

        const budgetAmount = inv.sub_document_id ? (subDocMap.get(inv.sub_document_id) ?? null) : null
        const overBudget = budgetAmount !== null && inv.total_amount > budgetAmount

        const { error: insertErr } = await supabase.from('payable_records').insert({
          budget_order_id: budgetOrderId,
          settlement_id: settlement.id,
          invoice_id: inv.id,
          order_no: order?.order_no || null,
          supplier_name: inv.supplier_name || '未知供应商',
          description: `${inv.invoice_no || ''} - ${inv.supplier_name || ''}`.trim(),
          cost_category: invoiceTypeToCostCategory[inv.invoice_type] || 'other',
          amount: inv.total_amount,
          currency: inv.currency,
          budget_amount: budgetAmount,
          over_budget: overBudget,
          due_date: inv.due_date,
          payment_status: 'unpaid',
        })
        if (!insertErr) payablesCreated++
      }
    }

    // 5. 发送企业微信通知（非阻塞）
    if (invoices?.length) {
      const earliestDue = invoices
        .filter(i => i.due_date)
        .map(i => i.due_date as string)
        .sort()[0]

      notifyPaymentReminder({
        supplier: (order?.order_no || budgetOrderId) + ' 决算确认',
        amount: settlement.total_actual || 0,
        currency: 'CNY',
        dueDate: earliestDue || '待定',
        affectsProduction: false,
      }).catch(err => console.error('[WeChat] 付款通知发送失败:', err))
    }

    return NextResponse.json({
      success: true,
      settlementId: settlement.id,
      payablesCreated,
      message: `决算已确认，生成 ${payablesCreated} 条应付记录`,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '确认失败' },
      { status: 500 }
    )
  }
}
