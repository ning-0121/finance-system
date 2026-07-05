// ============================================================
// Action Execution Engine — 安全优先执行引擎
// L1-L4安全等级 + 门槛检查 + 幂等性 + 重试 + 审计
// 原则：宁可保守，不要出错
// ============================================================

import { createClient } from '@/lib/supabase/client'
import { getActionsForCategory, canExecuteAction, type ActionConfig } from './action-registry'
import { assessSafety, SAFETY_LEVEL_CONFIG, type SafetyLevel } from './safety'
import { topologicalSort, checkDependencies, updateTrustScore } from './dependency-resolver'
import type { DocCategory, ExtractionResult } from '@/lib/types/document'
import { bizToday } from '@/lib/biz-date'

export interface ExecutionResult {
  action_type: string
  label: string
  status: 'success' | 'failed' | 'skipped'
  target_table: string
  record_id: string | null
  error: string | null
  retry_count: number
}

export interface ExecutionSummary {
  document_id: string
  total_actions: number
  succeeded: number
  failed: number
  skipped: number
  results: ExecutionResult[]
  audit_log_id: string | null
}

// --- 主执行函数（安全优先） ---
export async function executeDocumentActions(
  documentId: string,
  docCategory: DocCategory,
  confirmedFields: Record<string, unknown>,
  confirmedBy: string,
  extraction?: ExtractionResult,
  approvedActions?: string[]
): Promise<ExecutionSummary> {
  const supabase = createClient()
  const configs = getActionsForCategory(docCategory)
  const results: ExecutionResult[] = []

  // ===== 安全评估 =====
  const safetyAssessment = extraction ? assessSafety(extraction) : null
  const maxAllowedLevel = safetyAssessment?.max_allowed_level || 'L1'

  const levelOrder: Record<SafetyLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 }

  // ===== 拓扑排序 =====
  const { sorted: sortedConfigs } = topologicalSort(configs)
  const executedActions = new Map<string, 'success' | 'failed' | 'skipped'>()

  for (const config of sortedConfigs) {
    // 0. 动作级过滤：只执行用户approved的动作
    if (approvedActions && !approvedActions.includes(config.action_type)) {
      results.push({
        action_type: config.action_type, label: config.label,
        status: 'skipped', target_table: config.target_table,
        record_id: null, error: '用户未选择执行此动作', retry_count: 0,
      })
      executedActions.set(config.action_type, 'skipped')
      continue
    }

    // 0.5. 依赖检查：前置动作是否满足
    if (config.depends_on.length > 0) {
      const depCheck = checkDependencies(config, executedActions)
      if (!depCheck.satisfied) {
        results.push({
          action_type: config.action_type, label: config.label,
          status: 'skipped', target_table: config.target_table,
          record_id: null, error: `被依赖阻塞: ${depCheck.reason}`, retry_count: 0,
        })
        executedActions.set(config.action_type, 'skipped')
        continue
      }
    }

    // 1. 安全等级检查：动作等级不能超过允许的最高等级
    const actionLevel = config.safety_level || 'L2'
    if (levelOrder[actionLevel] > levelOrder[maxAllowedLevel]) {
      const levelConfig = SAFETY_LEVEL_CONFIG[actionLevel]
      results.push({
        action_type: config.action_type, label: config.label,
        status: 'skipped', target_table: config.target_table,
        record_id: null,
        error: `安全等级${actionLevel}(${levelConfig.description})超过当前允许的${maxAllowedLevel}，需人工确认后执行`,
        retry_count: 0,
      })
      continue
    }

    // 2. 字段检查
    const { canExecute, missingFields } = canExecuteAction(config, confirmedFields)
    if (!canExecute) {
      results.push({
        action_type: config.action_type, label: config.label,
        status: 'skipped', target_table: config.target_table,
        record_id: null, error: `缺少字段: ${missingFields.join(', ')}`, retry_count: 0,
      })
      executedActions.set(config.action_type, 'skipped')
      continue
    }

    // 3. 执行（带重试）
    const result = await executeWithRetry(config, confirmedFields, documentId, confirmedBy)
    results.push(result)
    executedActions.set(config.action_type, result.status === 'success' ? 'success' : 'failed')

    // 3.5. 更新信任分值
    const entityName = String(confirmedFields.customer_name || confirmedFields.supplier_name || '')
    if (entityName) {
      const subjectType = confirmedFields.customer_name ? 'customer' : 'supplier'
      await updateTrustScore(subjectType, entityName, result.status === 'success' ? 'correct' : 'rejected')
    }

    // 4. 关键动作失败 → 后续跳过（依赖图已处理大部分，这里是额外保护）
    // Wave 3-B P2-E8: 透传根因，不再吞失败 action 的 error 详情
    if (result.status === 'failed' && config.execution_order <= 1) {
      const rootCause = result.error || '(未知错误)'
      for (const remaining of configs.filter(c => c.execution_order > config.execution_order)) {
        results.push({
          action_type: remaining.action_type, label: remaining.label,
          status: 'skipped', target_table: remaining.target_table,
          record_id: null,
          error: `前置动作 ${config.label} 失败 → 跳过。根因: ${rootCause}`,
          retry_count: 0,
        })
      }
      break
    }
  }

  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.filter(r => r.status === 'failed').length
  const skipped = results.filter(r => r.status === 'skipped').length

  // 写入审计日志
  let auditLogId: string | null = null
  try {
    const { data: audit } = await supabase.from('financial_agent_actions').insert({
      action_type: 'auto_risk_detection',
      target_type: 'document',
      target_id: documentId,
      summary: `文档执行: ${succeeded}成功 ${failed}失败 ${skipped}跳过`,
      detail: {
        doc_category: docCategory,
        confirmed_by: confirmedBy,
        results,
        confirmed_fields_keys: Object.keys(confirmedFields).filter(k => !k.startsWith('_')),
      } as Record<string, unknown>,
      execution_result: failed > 0 ? 'failed' : 'success',
    }).select('id').single()
    auditLogId = audit?.id || null
  } catch (err) { console.error('审计日志写入失败:', err) }

  // 更新文档状态
  await supabase.from('uploaded_documents').update({
    status: failed > 0 ? 'extracted' : 'confirmed', // 有失败保持extracted状态
    confirmed_by: confirmedBy,
    confirmed_at: new Date().toISOString(),
  }).eq('id', documentId)

  // 更新document_actions状态（同步status和decision两个字段）
  for (const r of results) {
    if (r.status === 'success') {
      await supabase.from('document_actions')
        .update({ status: 'executed', decision: 'accepted', executed_at: new Date().toISOString(), executed_by: confirmedBy })
        .eq('document_id', documentId)
        .eq('action_type', r.action_type)
    } else if (r.status === 'failed') {
      // Wave 3-A P2-E2: 把 error 留到 document_actions.execution_error 供回滚追溯
      await supabase.from('document_actions')
        .update({ status: 'rejected', decision: 'rejected', execution_error: r.error })
        .eq('document_id', documentId)
        .eq('action_type', r.action_type)
    } else if (r.status === 'skipped' && r.error) {
      // skipped 也写 execution_error（含 P2-E8 透传的根因）
      await supabase.from('document_actions')
        .update({ execution_error: r.error })
        .eq('document_id', documentId)
        .eq('action_type', r.action_type)
    }
  }

  return { document_id: documentId, total_actions: results.length, succeeded, failed, skipped, results, audit_log_id: auditLogId }
}

// --- 带重试的单个动作执行 ---
async function executeWithRetry(
  config: ActionConfig,
  fields: Record<string, unknown>,
  documentId: string,
  confirmedBy: string,
  maxRetries = 2
): Promise<ExecutionResult> {
  let lastError = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const recordId = await executeSingleAction(config, fields, documentId, confirmedBy)
      return {
        action_type: config.action_type, label: config.label,
        status: 'success', target_table: config.target_table,
        record_id: recordId, error: null, retry_count: attempt,
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error'
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
      }
    }
  }

  return {
    action_type: config.action_type, label: config.label,
    status: 'failed', target_table: config.target_table,
    record_id: null, error: lastError, retry_count: maxRetries,
  }
}

// --- 执行单个业务动作 ---
async function executeSingleAction(
  config: ActionConfig,
  fields: Record<string, unknown>,
  documentId: string,
  confirmedBy: string
): Promise<string | null> {
  const supabase = createClient()
  const f = fields

  switch (config.action_type) {
    case 'create_order':
    case 'create_budget': {
      // 必须有客户信息才能创建订单
      const customerName = String(f.customer_name || '')
      if (!customerName) throw new Error('create_order: 文档中缺少客户名称，无法创建预算单')
      if (!confirmedBy) throw new Error('create_order: 操作者 ID 不能为空')

      // 按名称查找客户
      const { data: customerRows } = await supabase
        .from('customers')
        .select('id')
        .ilike('company', `%${customerName}%`)
        .limit(1)
      if (!customerRows?.length) {
        throw new Error(`create_order: 未找到客户"${customerName}"，请先在档案中创建该客户`)
      }
      const customerId = customerRows[0].id

      // Phase 3 path C: 如果文档抽取出报价细项，构建 _cost_breakdown
      // 来自 OCR 的字段：fabric_amount / accessory_amount / processing_amount /
      //                forwarder_amount / container_amount / logistics_amount (单位 CNY)
      const breakdown: Record<string, unknown> = {}
      const num = (k: string): number => Number(f[k] || 0)
      const fabric = num('fabric_amount')
      const accessory = num('accessory_amount')
      const processing = num('processing_amount')
      const forwarder = num('forwarder_amount')
      const container = num('container_amount')
      const logistics = num('logistics_amount')
      const hasBreakdown = fabric + accessory + processing + forwarder + container + logistics > 0
      if (hasBreakdown) {
        breakdown._cost_breakdown = {
          fabric, accessory, processing, forwarder, container, logistics,
          extras: [],
          _currency: 'CNY',
          _revenue_input: Number(f.total_amount) || 0,
          _revenue_currency: String(f.currency || 'USD'),
          _rate: Number(f.exchange_rate || 1),
          _source: 'document_ocr',
          _source_document_id: documentId,
        }
      }
      const itemsField = hasBreakdown ? [breakdown] : []
      const totalCost = fabric + accessory + processing + forwarder + container + logistics
      const revenueCny = String(f.currency || 'USD') === 'CNY'
        ? Number(f.total_amount) || 0
        : (Number(f.total_amount) || 0) * (Number(f.exchange_rate) || 1)
      const profit = revenueCny - totalCost
      const margin = revenueCny > 0 ? Math.round((profit / revenueCny) * 10000) / 100 : 0

      // 幂等：检查是否已创建
      const poNo = (f.po_number || f.order_no || '') as string
      if (poNo) {
        const { data: existing } = await supabase.from('budget_orders').select('id').ilike('notes', `%${poNo}%`).limit(1)
        if (existing?.length) {
          // 如果已有订单但缺 _cost_breakdown，补一次（不覆盖已有的 breakdown）
          if (hasBreakdown) {
            const { data: existingOrder } = await supabase.from('budget_orders').select('items').eq('id', existing[0].id).single()
            const existingItems = (existingOrder?.items as unknown as Record<string, unknown>[]) || []
            const hasExistingBreakdown = existingItems[0]?._cost_breakdown
            if (!hasExistingBreakdown) {
              await supabase.from('budget_orders').update({
                items: itemsField as never,
                target_purchase_price: fabric + accessory,
                estimated_freight: forwarder,
                estimated_commission: processing,
                total_cost: totalCost,
                estimated_profit: profit,
                estimated_margin: margin,
              }).eq('id', existing[0].id)
            }
          }
          return existing[0].id
        }
      }
      const { data, error } = await supabase.from('budget_orders').insert({
        order_no: '',
        customer_id: customerId,
        total_revenue: Number(f.total_amount) || 0,
        currency: String(f.currency || 'USD'),
        exchange_rate: Number(f.exchange_rate) || null,
        items: itemsField as never,
        target_purchase_price: hasBreakdown ? fabric + accessory : 0,
        estimated_freight: hasBreakdown ? forwarder : 0,
        estimated_commission: hasBreakdown ? processing : 0,
        total_cost: totalCost,
        estimated_profit: profit,
        estimated_margin: margin,
        product_name: f.product_name ? String(f.product_name) : null,
        status: 'draft',
        created_by: confirmedBy,
        notes: `来源: 文档智能导入\nPO: ${f.po_number || ''}\n客户: ${customerName}`,
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    case 'create_payment_request': {
      if (!confirmedBy) throw new Error('create_payment_request: 操作者 ID 不能为空')

      // 必须有供应商信息
      const supplierName = String(f.supplier_name || f.logistics_company || '')
      if (!supplierName) throw new Error('create_payment_request: 文档中缺少供应商名称')

      // 幂等：检查发票号
      const invNo = (f.invoice_no || `DOC-${documentId.slice(0, 8)}`) as string
      const { data: existing } = await supabase.from('actual_invoices').select('id').eq('invoice_no', invNo).limit(1)
      if (existing?.length) return existing[0].id

      // 尝试从文档中找到关联订单（有则关联，无则草稿挂起等待人工关联）
      let budgetOrderId: string | null = null
      const poRef = String(f.po_number || f.order_no || '')
      if (poRef) {
        const { data: orderRows } = await supabase
          .from('budget_orders')
          .select('id')
          .ilike('notes', `%${poRef}%`)
          .limit(1)
        budgetOrderId = orderRows?.[0]?.id ?? null
      }
      if (!budgetOrderId) {
        // 查找该供应商最近的 draft 订单作为关联
        const { data: recentOrder } = await supabase
          .from('budget_orders')
          .select('id')
          .eq('status', 'draft')
          .order('created_at', { ascending: false })
          .limit(1)
        budgetOrderId = recentOrder?.[0]?.id ?? null
      }
      if (!budgetOrderId) {
        throw new Error(`create_payment_request: 无法找到关联的预算单（供应商: ${supplierName}，PO: ${poRef || '未知'}）。请先创建对应预算单。`)
      }

      const { data, error } = await supabase.from('actual_invoices').insert({
        budget_order_id: budgetOrderId,
        invoice_type: 'supplier_invoice',
        invoice_no: invNo,
        supplier_name: supplierName,
        total_amount: Number(f.total_amount || f.amount || 0),
        currency: String(f.currency || 'USD'),
        status: 'pending',
        created_by: confirmedBy,
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    case 'link_cost_item': {
      // Wave 3-B P2-E1: actor 不能 fallback 到零 UUID（会让 provenance 丢失归属）
      if (!confirmedBy) throw new Error('link_cost_item: 操作者 ID 不能为空')
      // 汇率：禁止外币按 1:1 折人民币（下游所有报表按 amount×exchange_rate 折算）。
      // 外币费用必须带文档汇率，否则拒绝入账（请改为手工录入并填汇率）。
      const docCurrency = String(f.currency || 'CNY').toUpperCase()
      let docRate = 1
      if (docCurrency !== 'CNY' && docCurrency !== 'RMB') {
        docRate = Number(f.exchange_rate) || 0
        if (!docRate) throw new Error(`link_cost_item: ${docCurrency} 费用缺少汇率，拒绝按 1:1 入账，请手工录入并填写汇率`)
      }
      const { data, error } = await supabase.from('cost_items').insert({
        cost_type: String(f._cost_type || 'procurement'),
        description: `文档导入: ${f.supplier_name || f.logistics_company || f.description || ''}`,
        amount: Number(f.total_amount || f.amount || 0),
        currency: docCurrency,
        exchange_rate: docRate,
        source_module: 'document_intelligence',
        source_id: documentId,
        created_by: confirmedBy,
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    case 'update_receivable': {
      // Wave 2 P0-E2 修复：客户回款 = subledger + GL 同事务原子
      // 旧版只插 actual_invoices(status='paid') 无 GL → trial balance 看不到现金，AR 不对冲
      // 新版调 record_customer_receipt_atomic RPC：Dr Cash / Cr AR + ar_received_amount 累加
      if (!confirmedBy) throw new Error('update_receivable: 操作者 ID 不能为空')
      const payerName = String(f.payer_name || f.customer_name || '')
      if (!payerName) throw new Error('update_receivable: 文档中缺少付款方名称')

      // 找关联订单（按客户名 fuzzy）
      const { data: custRows } = await supabase
        .from('customers').select('id').ilike('company', `%${payerName}%`).limit(1)
      if (!custRows?.length) {
        throw new Error(`update_receivable: 未找到客户"${payerName}"，请先创建客户档案`)
      }
      const { data: orderRows } = await supabase
        .from('budget_orders').select('id')
        .eq('customer_id', custRows[0].id)
        .in('status', ['approved', 'draft'])
        .is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(1)
      const recvOrderId = orderRows?.[0]?.id
      if (!recvOrderId) {
        throw new Error(`update_receivable: 客户"${payerName}"没有 approved/draft 订单`)
      }

      const amount = Number(f.amount || f.total_amount || 0)
      if (!amount || amount <= 0) throw new Error('update_receivable: 金额必须 > 0')
      const transactionDate = (f.transaction_date as string) || bizToday()
      const currency = String(f.currency || 'USD').toUpperCase()

      // 审计 P0-3:外币回款必须带真实汇率折 CNY 入账(否则 GL 现金/应收双双失真)。
      // 优先用单据汇率,缺则取订单汇率;外币仍无汇率 → 拒绝(不再静默按 1:1)。
      let exchangeRate = Number(f.exchange_rate || 0)
      if (currency === 'CNY') exchangeRate = 1
      if (!exchangeRate || exchangeRate <= 0) {
        const { data: ord } = await supabase.from('budget_orders').select('exchange_rate').eq('id', recvOrderId).maybeSingle()
        exchangeRate = Number((ord as { exchange_rate?: number } | null)?.exchange_rate) || 0
      }
      if (!exchangeRate || exchangeRate <= 0) {
        throw new Error(`update_receivable: 外币回款(${currency})缺汇率，无法折算入账。请在单据或订单上补录汇率后重试。`)
      }

      // RPC 内部完整事务：actual_invoices + journal_entries + journal_lines + gl_balances
      // 任一失败整体 rollback，executor 收到 throw → retry → 永久失败时 subledger 也不存在
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        'record_customer_receipt_atomic',
        {
          p_budget_order_id: recvOrderId,
          p_payer_name: payerName,
          p_amount: amount,
          p_currency: currency,
          p_transaction_date: transactionDate,
          p_actor_id: confirmedBy,
          p_invoice_no: `RCV-${Date.now().toString(36)}`,
          p_exchange_rate: exchangeRate,
        } as never,
      )
      if (rpcErr) throw new Error(`record_customer_receipt_atomic: ${rpcErr.message}`)
      const r = rpcResult as { invoice_id: string; journal_id: string; voucher_no: string }
      // 返回 invoice_id（与原行为一致，但同时 GL 已 posted）
      return r.invoice_id
    }

    case 'update_customer_credit': {
      const name = String(f.payer_name || f.customer_name || '')
      if (!name) return null
      const { data } = await supabase.from('customer_financial_profiles').select('id').ilike('customer_name', `%${name}%`).limit(1)
      if (data?.length) {
        await supabase.from('customer_financial_profiles').update({ last_updated_at: new Date().toISOString() }).eq('id', data[0].id)
        return data[0].id
      }
      return null
    }

    case 'update_cashflow': {
      const { data, error } = await supabase.from('cashflow_forecasts').insert({
        forecast_date: bizToday(),
        expected_inflow: Number(f.amount || f.total_amount || f.refund_amount || 0),
        expected_outflow: 0,
        expected_cash_balance: 0,
        warning_level: 'safe',
        scenario: 'normal',
        suggested_action: `文档导入: ${f.payer_name || f.customer_name || ''}`,
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    case 'update_shipping_status': {
      // 需要明确的订单号才能更新出货状态
      const shipOrderRef = String(f.po_number || f.order_no || f.bl_no || '')
      if (!shipOrderRef) throw new Error('update_shipping_status: 文档中缺少订单号或提单号，无法更新出货状态')
      // 查找对应出货单
      const { data: shipRows } = await supabase
        .from('shipping_documents')
        .select('id, status')
        .ilike('document_no', `%${shipOrderRef}%`)
        .limit(1)
      if (!shipRows?.length) {
        throw new Error(`update_shipping_status: 未找到出货单"${shipOrderRef}"，请检查单据编号`)
      }
      const { error } = await supabase
        .from('shipping_documents')
        .update({ status: 'completed' })
        .eq('id', shipRows[0].id)
        .neq('status', 'completed') // 幂等
      if (error) throw new Error(error.message)
      return shipRows[0].id
    }

    case 'create_risk_check': {
      const { data, error } = await supabase.from('financial_risk_events').insert({
        risk_type: 'low_profit_order',
        risk_level: 'yellow',
        title: `文档触发检查: ${f.customer_name || f.supplier_name || ''}`,
        description: `来源文档: ${documentId}`,
        suggested_action: '请人工确认风险等级',
        status: 'pending',
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    default:
      return null
  }
}
