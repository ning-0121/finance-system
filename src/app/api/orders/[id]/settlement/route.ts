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
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { notifyPaymentReminder } from '@/lib/wecom/notifications'
import { enqueueAndProcess } from '@/lib/accounting/gl-queue'
import { notifyFinanceProgress } from '@/lib/integration/client'
import { safeRate } from '@/lib/accounting/utils'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  // 审计 P0:确认决算=结转成本 GL + 批量生成应付,资金后果严重,仅 admin/财务经理
  const roleErr = requireRole(auth, ['admin', 'finance_manager'])
  if (roleErr) return roleErr

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
      .select('order_no, exchange_rate')
      .eq('id', budgetOrderId)
      .single()
    const orderNo = order?.order_no || null

    const { data: subDocs } = await supabase
      .from('budget_sub_documents')
      .select('id, estimated_total, actual_total')
      .eq('budget_order_id', budgetOrderId)

    // ── Option 2(2026-07-10 老板拍板):决算生成应付【从 cost_items 派生】,不再用 actual_invoices ──
    // 现实(审计实测):本部署成本都归集在 cost_items、发票表基本空;GL 结转成本(贷 2202)本就用 cost_items。
    // 让应付/付款(借 2202)也来自 cost_items → 2202 一贷一借同源、能对平,且贴合实际在用的数据。
    // 按【供应商 + 币种】聚合成逐笔应付(一供应商一笔、单币种);invoice_id=null(无发票);
    // due_date 取该组最晚 delivery_date 作账期近似;金额折 CNY 由 payable_records 触发器/消费端负责。
    const CT2PAYCAT: Record<string, string> = {
      fabric: 'raw_material', accessory: 'raw_material', procurement: 'raw_material',
      processing: 'factory', commission: 'factory',
      freight: 'freight', forwarder: 'freight', logistics: 'freight',
      container: 'other', customs: 'other', tax: 'tax', other: 'other',
    }
    // D1 3b-2:排除采购对账来源的 cost_items —— 它们已由采购对账建了(分期)应付,决算不再重复派生
    // (采购成本记 cost_items 只为进毛利/决算利润,不作为应付来源;应付走采购对账 payable_records)。
    const { data: costItems } = await supabase.from('cost_items')
      .select('amount, currency, exchange_rate, supplier, cost_type, delivery_date')
      .eq('budget_order_id', budgetOrderId).neq('cost_type', 'tax_point')
      .or('source_module.is.null,source_module.neq.procurement_reconciliation')
      .is('deleted_at', null)
    const payGroups = new Map<string, { supplier: string; currency: string; amount: number; cat: string; due: string | null; n: number }>()
    for (const c of costItems || []) {
      const supplier = (c.supplier as string) || '未知供应商'
      const currency = (c.currency as string) || 'CNY'
      const key = `${supplier}|||${currency}`
      const g = payGroups.get(key)
      const due = (c.delivery_date as string) || null
      if (g) {
        g.amount += Number(c.amount) || 0; g.n++
        if (due && (!g.due || due > g.due)) g.due = due
      } else {
        payGroups.set(key, { supplier, currency, amount: Number(c.amount) || 0, cat: CT2PAYCAT[(c.cost_type as string) || 'other'] || 'other', due, n: 1 })
      }
    }
    const payablesJson = [...payGroups.values()].map(g => ({
      invoice_id: null,                              // 来自费用归集,无发票
      supplier_name: g.supplier,
      description: `费用归集派生(${g.n} 项)`,
      cost_category: g.cat,
      amount: Math.round(g.amount * 100) / 100,
      currency: g.currency,
      budget_amount: null,
      over_budget: false,
      due_date: g.due,
    }))

    // ── 决算实际性守卫(P1-G):无实际成本 / 子核算单未归集 不让确认 ──
    // (Option 2 后不再需要 cost_items vs actual_invoices 对账闸——应付本身就来自 cost_items、天然一致。)
    // 财务经理复核后确需带情况确认 → body 传 acknowledgeDivergence:true 显式放行并留痕。
    const body = await request.json().catch(() => ({} as Record<string, unknown>))
    const acknowledged = (body as Record<string, unknown>)?.acknowledgeDivergence === true
    const r2 = (n: number) => Math.round(n * 100) / 100
    const costCnyTotal = r2((costItems || []).reduce((s, c) =>
      s + (Number(c.amount) || 0) * safeRate(c.exchange_rate == null ? null : Number(c.exchange_rate), (c.currency as string) || 'CNY', '决算守卫'), 0))
    const unsettledSub = (subDocs || []).filter(d => d.actual_total == null)
    const noActual = costCnyTotal <= 0 && (subDocs || []).length === 0

    if (!acknowledged) {
      if (noActual) {
        return NextResponse.json({ error: '无任何实际成本归集(费用归集为 0、无子核算单),确认决算会把全部收入当利润。请先归集实际成本,或财务经理复核后带 acknowledgeDivergence 确认。', gate: 'no_actual' }, { status: 409 })
      }
      if (unsettledSub.length > 0) {
        return NextResponse.json({ error: `有 ${unsettledSub.length} 张子核算单未归集实际(actual_total 为空),确认决算会把预算当实际计入成本。请先归集,或复核后带 acknowledgeDivergence 确认。`, gate: 'sub_unsettled' }, { status: 409 })
      }
    } else if (noActual || unsettledSub.length > 0) {
      try {
        await supabase.from('save_diagnostic_logs').insert({
          action: 'settlement_confirm_override', table_name: 'order_settlements', record_id: settlement.id,
          source_page: 'api/orders/settlement', status: 'warning',
          error_detail: `带情况确认决算(order=${orderNo}):费用归集¥${costCnyTotal};未结子核算单${unsettledSub.length}张;确认人=${auth.userId}`,
          actor_id: auth.userId ?? null,
        })
      } catch (e) { console.error('[settlement] 带情况确认留痕失败:', e) }
    }

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

    // 3b. 结转成本凭证 → GL 受控灰度：仅入队 + 生成 draft，等财务经理复核后过账。
    //     非阻塞、幂等；任何异常进异常中心，不回滚已确认的决算与应付。
    try {
      await enqueueAndProcess({
        businessEvent: 'settlement_confirmed',
        sourceType: 'settlement',
        sourceId: budgetOrderId,
        createdBy: auth.userId,
      })
    } catch (err) {
      console.error('[GL] 结转成本入队失败（决算已确认，不影响业务）:', err)
    }

    // 4. 企业微信通知（非阻塞、非关键，失败也不影响 confirm 结果）
    if (payablesJson.length) {
      const earliestDue = payablesJson
        .filter(pj => pj.due_date).map(pj => pj.due_date as string).sort()[0]
      notifyPaymentReminder({
        supplier: `${orderNo || budgetOrderId} 决算确认`,
        amount: settlement.total_actual || 0,
        currency: 'CNY',
        dueDate: earliestDue || '待定',
        affectsProduction: false,
      }).catch(err => console.error('[WeChat] 付款通知发送失败:', err))
    }

    // 5. 出站回传节拍器：订单财务决算完成（审计 P1④，非阻塞；用 qimo_order_id 精确关联）
    try {
      const { data: bo } = await supabase.from('budget_orders').select('qimo_order_id').eq('id', budgetOrderId).maybeSingle()
      if (bo?.qimo_order_id) {
        notifyFinanceProgress('settlement.closed', {
          qimo_order_id: bo.qimo_order_id as string,
          order_no: orderNo,
          amount: settlement.total_actual || 0,
          currency: 'CNY',
          note: `决算确认，生成 ${r.payables_created} 条应付`,
        }).catch(err => console.error('[Integration] settlement.closed 回传失败:', err))
      }
    } catch (err) {
      console.error('[Integration] 回传节拍器前查询失败:', err)
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
