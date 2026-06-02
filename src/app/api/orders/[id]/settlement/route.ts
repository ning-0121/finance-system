// ============================================================
// POST /api/orders/[id]/settlement — 确认订单决算单
//
// Wave 2 P0-E1 改造（vs 原版）：
//   旧：route 先 settlement.update→confirmed，再 for-loop 单条 insert payables
//        中段失败 → settlement=confirmed + 部分 payables 缺失（分账与 GL 永久背离）
//   新：route 只准备数据，把决算确认 + 应付批量插入压到单个 RPC
//        confirm_settlement_with_payables_atomic
//        任一 INSERT 失败 → 全事务 rollback，决算保持 draft，应付 0 条
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { notifyPaymentReminder } from '@/lib/wecom/notifications'
import { postCostRecognition } from '@/lib/accounting/gl-posting'
import type { BudgetOrder } from '@/lib/types'

const INVOICE_TYPE_TO_COST_CATEGORY: Record<string, string> = {
  purchase_order: 'raw_material', supplier_invoice: 'raw_material',
  factory_contract: 'factory', factory_statement: 'factory',
  freight_bill: 'freight', commission_bill: 'commission',
  tax_invoice: 'tax', other_invoice: 'other',
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { id: budgetOrderId } = await params

  try {
    const supabase = await createClient()

    // 1. 决算单存在性 + 状态前置检查（提供更友好的 4xx 错误）
    const { data: settlement, error: fetchErr } = await supabase
      .from('order_settlements')
      .select('id, status, total_actual, budget_order_id, deleted_at')
      .eq('budget_order_id', budgetOrderId)
      .single()
    if (fetchErr || !settlement) {
      return NextResponse.json({ error: '决算单不存在，请先生成决算单' }, { status: 404 })
    }
    if (settlement.deleted_at) {
      return NextResponse.json({ error: '决算单已软删除，无法确认' }, { status: 410 })
    }
    if (settlement.status === 'confirmed' || settlement.status === 'locked') {
      return NextResponse.json({ error: '决算单已确认，请勿重复操作' }, { status: 409 })
    }
    if (settlement.status !== 'draft') {
      return NextResponse.json({ error: `决算单当前状态 ${settlement.status} 不可确认（仅 draft 可确认）` }, { status: 409 })
    }

    // 2. 准备应付数据（route 层只组装 jsonb，不写 DB）
    const { data: order } = await supabase
      .from('budget_orders')
      .select('order_no')
      .eq('id', budgetOrderId)
      .single()
    const orderNo = order?.order_no || null

    const { data: invoices } = await supabase
      .from('actual_invoices')
      .select('id, invoice_no, supplier_name, invoice_type, total_amount, currency, due_date, status, sub_document_id')
      .eq('budget_order_id', budgetOrderId)
      .is('deleted_at', null)
      .in('status', ['approved', 'pending'])

    const { data: subDocs } = await supabase
      .from('budget_sub_documents')
      .select('id, estimated_total')
      .eq('budget_order_id', budgetOrderId)
    const subDocMap = new Map<string, number>()
    subDocs?.forEach(d => subDocMap.set(d.id, d.estimated_total || 0))

    const payablesJson = (invoices || []).map(inv => {
      const budgetAmount = inv.sub_document_id ? (subDocMap.get(inv.sub_document_id) ?? null) : null
      const overBudget = budgetAmount !== null && inv.total_amount > budgetAmount
      return {
        invoice_id: inv.id,
        supplier_name: inv.supplier_name || '未知供应商',
        description: `${inv.invoice_no || ''} - ${inv.supplier_name || ''}`.trim(),
        cost_category: INVOICE_TYPE_TO_COST_CATEGORY[inv.invoice_type] || 'other',
        amount: inv.total_amount,
        currency: inv.currency,
        budget_amount: budgetAmount,
        over_budget: overBudget,
        due_date: inv.due_date,
      }
    })

    // 3. 单 RPC 调用：决算 confirm + 应付 batch insert 全原子
    const { data: rpcResult, error: rpcErr } = await supabase.rpc(
      'confirm_settlement_with_payables_atomic',
      {
        p_settlement_id: settlement.id,
        p_actor_id: auth.userId!,
        p_order_no: orderNo,
        p_payables: payablesJson,
      } as never,
    )

    if (rpcErr) {
      // 业务异常（FOR_UPDATE 冲突、status 不为 draft、应付 INSERT 失败等）已被 RPC RAISE
      // 此时 RPC 已 rollback，决算仍是 draft
      return NextResponse.json({
        error: `决算确认失败: ${rpcErr.message}`,
        atomic: true,
        rollback: true,
      }, { status: 500 })
    }

    const r = rpcResult as { settlement_id: string; settlement_status: string; settled_at: string; payables_created: number }

    // 3b. 结转成本凭证（借 主营业务成本/销售费用 / 贷 应付账款）
    //     非阻塞、幂等（postCostRecognition 内按 (settlement, orderId) 自检）；
    //     过账失败不回滚已确认的决算与应付，仅记录告警。
    try {
      const { data: bo } = await supabase
        .from('budget_orders')
        .select('id, order_no, order_date, target_purchase_price, estimated_commission, estimated_freight, estimated_customs_fee, other_costs, items')
        .eq('id', budgetOrderId)
        .single()
      if (bo) await postCostRecognition(bo as unknown as BudgetOrder)
    } catch (err) {
      console.error('[GL] 结转成本过账失败（决算已确认，不影响业务）:', err)
    }

    // 4. 企业微信通知（非阻塞、非关键，失败也不影响 confirm 结果）
    if (invoices?.length) {
      const earliestDue = invoices
        .filter(i => i.due_date).map(i => i.due_date as string).sort()[0]
      notifyPaymentReminder({
        supplier: `${orderNo || budgetOrderId} 决算确认`,
        amount: settlement.total_actual || 0,
        currency: 'CNY',
        dueDate: earliestDue || '待定',
        affectsProduction: false,
      }).catch(err => console.error('[WeChat] 付款通知发送失败:', err))
    }

    return NextResponse.json({
      success: true,
      settlementId: r.settlement_id,
      settlementStatus: r.settlement_status,
      payablesCreated: r.payables_created,
      message: `决算已确认，生成 ${r.payables_created} 条应付记录`,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '确认失败' },
      { status: 500 }
    )
  }
}
