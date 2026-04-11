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
    if (result.status === 'failed' && config.execution_order <= 1) {
      for (const remaining of configs.filter(c => c.execution_order > config.execution_order)) {
        results.push({
          action_type: remaining.action_type, label: remaining.label,
          status: 'skipped', target_table: remaining.target_table,
          record_id: null, error: `前置动作 ${config.label} 失败，跳过`, retry_count: 0,
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
      await supabase.from('document_actions')
        .update({ status: 'rejected', decision: 'rejected' })
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
      // 幂等：检查是否已创建
      const poNo = (f.po_number || f.order_no || '') as string
      if (poNo) {
        const { data: existing } = await supabase.from('budget_orders').select('id').ilike('notes', `%${poNo}%`).limit(1)
        if (existing?.length) return existing[0].id // 已存在，跳过
      }
      const { data, error } = await supabase.from('budget_orders').insert({
        order_no: '',
        customer_id: '00000000-0000-0000-0000-000000000000',
        total_revenue: Number(f.total_amount) || 0,
        currency: String(f.currency || 'USD'),
        status: 'draft',
        created_by: confirmedBy || '00000000-0000-0000-0000-000000000000',
        notes: `来源: 文档智能导入\nPO: ${f.po_number || ''}\n客户: ${f.customer_name || ''}`,
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    case 'create_payment_request': {
      // 幂等：检查发票号
      const invNo = (f.invoice_no || `DOC-${documentId.slice(0, 8)}`) as string
      const { data: existing } = await supabase.from('actual_invoices').select('id').eq('invoice_no', invNo).limit(1)
      if (existing?.length) return existing[0].id

      const { data, error } = await supabase.from('actual_invoices').insert({
        budget_order_id: '00000000-0000-0000-0000-000000000000',
        invoice_type: 'supplier_invoice',
        invoice_no: invNo,
        supplier_name: String(f.supplier_name || f.logistics_company || ''),
        total_amount: Number(f.total_amount || f.amount || 0),
        currency: String(f.currency || 'USD'),
        status: 'pending',
        created_by: confirmedBy || '00000000-0000-0000-0000-000000000000',
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    case 'link_cost_item': {
      const { data, error } = await supabase.from('cost_items').insert({
        cost_type: String(f._cost_type || 'procurement'),
        description: `文档导入: ${f.supplier_name || f.logistics_company || f.description || ''}`,
        amount: Number(f.total_amount || f.amount || 0),
        currency: String(f.currency || 'USD'),
        exchange_rate: 1,
        source_module: 'document_intelligence',
        source_id: documentId,
        created_by: confirmedBy || '00000000-0000-0000-0000-000000000000',
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
    }

    case 'update_receivable': {
      // 记录回款
      const { data, error } = await supabase.from('actual_invoices').insert({
        budget_order_id: '00000000-0000-0000-0000-000000000000',
        invoice_type: 'customer_statement',
        invoice_no: `RCV-${Date.now().toString(36)}`,
        supplier_name: String(f.payer_name || f.customer_name || ''),
        total_amount: Number(f.amount || f.total_amount || 0),
        currency: String(f.currency || 'USD'),
        status: 'paid',
        invoice_date: (f.transaction_date as string) || new Date().toISOString().split('T')[0],
        created_by: confirmedBy || '00000000-0000-0000-0000-000000000000',
      }).select('id').single()
      if (error) throw new Error(error.message)
      return data?.id || null
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
        forecast_date: new Date().toISOString().split('T')[0],
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
      // 简化：记录出货更新
      return null // shipping状态更新需要具体order_id，暂跳过
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
