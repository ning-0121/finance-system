// ============================================================
// POST /api/documents/pre-execute — 执行前预览（只评估不执行）
// 返回：安全评估 + 每个动作的影响预览 + explanation
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { getActionsForCategory, canExecuteAction } from '@/lib/document-engine/action-registry'
import { assessSafety, SAFETY_LEVEL_CONFIG, getFieldRiskLevel } from '@/lib/document-engine/safety'
import type { DocCategory, ExtractionResult } from '@/lib/types/document'

export interface PreExecutionAction {
  action_type: string
  label: string
  safety_level: string
  safety_label: string
  responsible_role: string
  target_table: string
  creates_todo: boolean
  creates_approval: boolean
  rollback_supported: boolean
  can_execute: boolean
  skip_reason: string | null
  explanation: string
  impact_summary: string
}

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const { document_id, confirmed_fields } = await request.json()
    if (!document_id) return NextResponse.json({ error: 'Missing document_id' }, { status: 400 })

    const supabase = await createClient()
    const { data: doc } = await supabase.from('uploaded_documents').select('*').eq('id', document_id).single()
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

    const docCategory = doc.doc_category as DocCategory
    const fields = confirmed_fields || doc.extracted_fields || {}
    const fieldConf = (doc.extracted_fields?._field_confidence || {}) as Record<string, number>
    const missingFields = (doc.extracted_fields?._missing_fields || []) as string[]
    const highRiskFields = (doc.extracted_fields?._high_risk_fields || []) as string[]

    // 构建ExtractionResult用于安全评估
    const extraction: ExtractionResult = {
      success: true,
      doc_category: docCategory,
      classification_confidence: (doc.doc_category_confidence || 0) * 100,
      extracted_fields: fields,
      field_confidence: fieldConf,
      missing_fields: missingFields,
      high_risk_fields: highRiskFields,
      duplicate_probability: (doc.extracted_fields?._duplicate_probability || 0) as number,
      raw_text_summary: (doc.extracted_fields?._summary || '') as string,
      template_match_result: null,
      extraction_method: (doc.extracted_fields?._extraction_method || 'vision') as ExtractionResult['extraction_method'],
    }

    // 安全评估
    const assessment = assessSafety(extraction)
    const configs = getActionsForCategory(docCategory)
    const levelOrder: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 }

    // 生成每个动作的预览
    const actions: PreExecutionAction[] = configs.map(config => {
      const actionLevel = config.safety_level || 'L2'
      const levelConfig = SAFETY_LEVEL_CONFIG[actionLevel]
      const { canExecute, missingFields: mf } = canExecuteAction(config, fields)
      const blocked = levelOrder[actionLevel] > levelOrder[assessment.max_allowed_level]

      let explanation = ''
      let skipReason: string | null = null

      if (blocked) {
        skipReason = `安全等级${actionLevel}(${levelConfig.description})超过当前允许的${assessment.max_allowed_level}`
        explanation = `❌ 被降级阻止 — ${skipReason}。${
          actionLevel === 'L3' ? '需财务经理(Su)审批后执行' :
          actionLevel === 'L4' ? '需老板审批后执行' : '需人工确认'
        }`
      } else if (!canExecute) {
        skipReason = `缺少必需字段: ${mf.join(', ')}`
        explanation = `⚠️ 无法执行 — ${skipReason}`
      } else {
        const amount = Number(fields.total_amount || fields.amount || 0)
        explanation = `✅ 可执行 — 分类置信度${Math.round(extraction.classification_confidence)}%`
        if (amount > 0) explanation += `，金额${fields.currency || 'USD'} ${amount.toLocaleString()}`
        if (config.creates_approval) explanation += '，将创建审批'
        if (config.creates_todo) explanation += '，将创建待办'
      }

      // 影响摘要
      const amount = Number(fields.total_amount || fields.amount || 0)
      let impact = `写入 ${config.target_table}`
      if (amount > 0) impact += ` · 金额 ${fields.currency || 'USD'} ${amount.toLocaleString()}`
      if (config.creates_todo) impact += ' · 创建待办'
      if (config.creates_approval) impact += ' · 需审批'

      return {
        action_type: config.action_type,
        label: config.label,
        safety_level: actionLevel,
        safety_label: levelConfig.label,
        responsible_role: config.responsible_role,
        target_table: config.target_table,
        creates_todo: config.creates_todo,
        creates_approval: config.creates_approval,
        rollback_supported: config.rollback_supported,
        can_execute: canExecute && !blocked,
        skip_reason: skipReason,
        explanation,
        impact_summary: impact,
      }
    })

    // 高风险字段摘要
    const fieldRiskSummary = Object.keys(fields)
      .filter(k => !k.startsWith('_'))
      .map(k => ({
        field: k,
        value: fields[k],
        risk_level: getFieldRiskLevel(k),
        confidence: fieldConf[k] || null,
        is_high_risk: highRiskFields.includes(k),
      }))
      .filter(f => f.risk_level !== 'low')

    return NextResponse.json({
      document_id,
      doc_category: docCategory,
      safety_assessment: {
        overall_safe: assessment.overall_safe,
        max_allowed_level: assessment.max_allowed_level,
        recommendation: assessment.recommendation,
        gates: assessment.gates,
        field_issues: assessment.field_issues,
        cross_validations: assessment.cross_validations,
      },
      actions,
      executable_count: actions.filter(a => a.can_execute).length,
      blocked_count: actions.filter(a => !a.can_execute).length,
      field_risk_summary: fieldRiskSummary,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
