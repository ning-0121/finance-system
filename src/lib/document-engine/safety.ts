// ============================================================
// 财务安全层 — 动作安全等级 + 字段风险分级 + 执行门槛 + 双重校验
// 原则：宁可保守，不要出错
// ============================================================

import type { DocCategory, ExtractionResult } from '@/lib/types/document'
import type { ActionConfig } from './action-registry'

// ============================================================
// 一、动作安全等级 L1-L4
// ============================================================
export type SafetyLevel = 'L1' | 'L2' | 'L3' | 'L4'

export const SAFETY_LEVEL_CONFIG: Record<SafetyLevel, {
  label: string
  description: string
  auto_execute: boolean    // 是否可自动执行
  requires_confirm: boolean // 是否需要责任人确认
  requires_approval: boolean // 是否需要审批
  requires_ceo: boolean     // 是否需要老板审批
}> = {
  L1: { label: '低风险', description: '可自动执行', auto_execute: true, requires_confirm: false, requires_approval: false, requires_ceo: false },
  L2: { label: '中风险', description: '自动生成草稿，需责任人确认', auto_execute: false, requires_confirm: true, requires_approval: false, requires_ceo: false },
  L3: { label: '高风险', description: '必须审批', auto_execute: false, requires_confirm: true, requires_approval: true, requires_ceo: false },
  L4: { label: '极高风险', description: '需老板审批', auto_execute: false, requires_confirm: true, requires_approval: true, requires_ceo: true },
}

// 每种动作的安全等级
export const ACTION_SAFETY_LEVELS: Record<string, SafetyLevel> = {
  // L1: 低风险
  'create_risk_check': 'L1',

  // L2: 中风险
  'create_order': 'L2',
  'create_budget': 'L2',
  'update_shipping_status': 'L2',
  'link_cost_item': 'L2',

  // L3: 高风险
  'create_payment_request': 'L3',
  'update_receivable': 'L3',
  'update_customer_credit': 'L3',
  'update_cashflow': 'L3',
}

export function getActionSafetyLevel(actionType: string): SafetyLevel {
  return ACTION_SAFETY_LEVELS[actionType] || 'L3'
}

// ============================================================
// 二、字段风险分级
// ============================================================
export type FieldRiskLevel = 'high' | 'medium' | 'low'

const HIGH_RISK_FIELDS = new Set([
  'total_amount', 'amount', 'currency', 'qty', 'unit_price',
  'bank_account', 'customer_name', 'supplier_name', 'payer_name',
  'tax_rate', 'tax_amount', 'payment_terms', 'invoice_no', 'po_number',
  'order_no', 'credit_limit', 'etd', 'eta',
])

const MEDIUM_RISK_FIELDS = new Set([
  'sku', 'product_name', 'carton_count', 'gross_weight', 'net_weight',
  'freight_amount', 'doc_category', 'logistics_company', 'factory_name',
  'contact', 'phone', 'email',
])

export function getFieldRiskLevel(fieldName: string): FieldRiskLevel {
  if (HIGH_RISK_FIELDS.has(fieldName)) return 'high'
  if (MEDIUM_RISK_FIELDS.has(fieldName)) return 'medium'
  return 'low'
}

// 高风险字段是否全部有值且被确认
export function validateHighRiskFields(
  fields: Record<string, unknown>,
  confirmedFields?: Set<string>
): { valid: boolean; issues: string[] } {
  const issues: string[] = []

  for (const field of HIGH_RISK_FIELDS) {
    if (field in fields) {
      const value = fields[field]
      // 金额字段额外验证
      if (['total_amount', 'amount', 'unit_price', 'tax_amount'].includes(field)) {
        const num = Number(value)
        if (isNaN(num) || num < 0) issues.push(`${field}: 金额无效(${value})`)
        if (num > 10000000) issues.push(`${field}: 金额异常大($${num.toLocaleString()})，请确认`)
      }
      // 币种验证
      if (field === 'currency') {
        const validCurrencies = ['USD', 'EUR', 'GBP', 'CNY', 'JPY', 'HKD', 'AUD', 'CAD']
        if (!validCurrencies.includes(String(value).toUpperCase())) {
          issues.push(`currency: 未知币种(${value})`)
        }
      }
    }
  }

  return { valid: issues.length === 0, issues }
}

// ============================================================
// 三、执行门槛
// ============================================================
export interface ExecutionGate {
  passed: boolean
  reason: string
  gate_name: string
}

export function checkExecutionGates(extraction: ExtractionResult): ExecutionGate[] {
  const gates: ExecutionGate[] = []

  // 门槛1: 分类置信度 > 70
  gates.push({
    gate_name: '分类置信度',
    passed: extraction.classification_confidence >= 70,
    reason: extraction.classification_confidence >= 70
      ? `✅ ${extraction.classification_confidence}% (≥70%)`
      : `❌ ${extraction.classification_confidence}% (<70%，不允许自动执行)`,
  })

  // 门槛2: 缺失字段 ≤ 2
  gates.push({
    gate_name: '缺失字段',
    passed: extraction.missing_fields.length <= 2,
    reason: extraction.missing_fields.length <= 2
      ? `✅ ${extraction.missing_fields.length}个缺失`
      : `❌ ${extraction.missing_fields.length}个缺失(>2，需人工补全)`,
  })

  // 门槛3: 重复概率 < 30
  gates.push({
    gate_name: '重复检测',
    passed: extraction.duplicate_probability < 30,
    reason: extraction.duplicate_probability < 30
      ? `✅ 重复概率${extraction.duplicate_probability}%`
      : `❌ 重复概率${extraction.duplicate_probability}%(≥30%，阻止自动执行)`,
  })

  // 门槛4: 高风险字段平均置信度 > 75
  const highRiskFieldConfs = Object.entries(extraction.field_confidence)
    .filter(([k]) => HIGH_RISK_FIELDS.has(k))
    .map(([, v]) => v)
  const avgHighRiskConf = highRiskFieldConfs.length > 0
    ? highRiskFieldConfs.reduce((s, v) => s + v, 0) / highRiskFieldConfs.length
    : 100

  gates.push({
    gate_name: '高风险字段置信度',
    passed: avgHighRiskConf >= 75,
    reason: avgHighRiskConf >= 75
      ? `✅ 均值${Math.round(avgHighRiskConf)}% (≥75%)`
      : `❌ 均值${Math.round(avgHighRiskConf)}% (<75%，高风险字段需确认)`,
  })

  return gates
}

export function allGatesPassed(gates: ExecutionGate[]): boolean {
  return gates.every(g => g.passed)
}

// ============================================================
// 四、双重校验
// ============================================================
export interface CrossValidation {
  field: string
  expected: number | string
  actual: number | string
  match: boolean
  variance_pct: number | null
  severity: 'ok' | 'warning' | 'error'
  message: string
}

export function crossValidateFields(
  extractedFields: Record<string, unknown>,
  systemData: {
    budgetAmount?: number
    receivableAmount?: number
    orderQty?: number
    historicalFreight?: number
    standardTaxRate?: number
  }
): CrossValidation[] {
  const validations: CrossValidation[] = []
  const f = extractedFields

  // 发票金额 vs 预算金额
  if (f.total_amount && systemData.budgetAmount) {
    const extracted = Number(f.total_amount)
    const budget = systemData.budgetAmount
    const variance = Math.abs(extracted - budget) / budget * 100
    validations.push({
      field: 'total_amount',
      expected: budget,
      actual: extracted,
      match: variance < 5,
      variance_pct: Math.round(variance * 100) / 100,
      severity: variance < 5 ? 'ok' : variance < 15 ? 'warning' : 'error',
      message: variance < 5
        ? `金额一致 (差异${variance.toFixed(1)}%)`
        : `⚠️ 金额差异${variance.toFixed(1)}% — 提取$${extracted.toLocaleString()} vs 预算$${budget.toLocaleString()}`,
    })
  }

  // 银行回单金额 vs 应收金额
  if ((f.amount || f.total_amount) && systemData.receivableAmount) {
    const extracted = Number(f.amount || f.total_amount)
    const receivable = systemData.receivableAmount
    const variance = Math.abs(extracted - receivable) / receivable * 100
    validations.push({
      field: 'amount_vs_receivable',
      expected: receivable,
      actual: extracted,
      match: variance < 1,
      variance_pct: Math.round(variance * 100) / 100,
      severity: variance < 1 ? 'ok' : variance < 5 ? 'warning' : 'error',
      message: variance < 1
        ? `回款金额一致`
        : `⚠️ 回款$${extracted.toLocaleString()} vs 应收$${receivable.toLocaleString()} (差异${variance.toFixed(1)}%)`,
    })
  }

  // 运费 vs 历史均值
  if (f.freight_amount && systemData.historicalFreight) {
    const extracted = Number(f.freight_amount)
    const historical = systemData.historicalFreight
    const variance = Math.abs(extracted - historical) / historical * 100
    validations.push({
      field: 'freight_vs_history',
      expected: historical,
      actual: extracted,
      match: variance < 20,
      variance_pct: Math.round(variance * 100) / 100,
      severity: variance < 20 ? 'ok' : variance < 40 ? 'warning' : 'error',
      message: variance < 20
        ? `运费正常范围`
        : `⚠️ 运费$${extracted.toLocaleString()} vs 历史均值$${historical.toLocaleString()} (偏差${variance.toFixed(0)}%)`,
    })
  }

  return validations
}

// ============================================================
// 五、综合安全评估
// ============================================================
export interface SafetyAssessment {
  overall_safe: boolean
  max_allowed_level: SafetyLevel  // 当前条件下最高可执行的安全等级
  gates: ExecutionGate[]
  field_issues: string[]
  cross_validations: CrossValidation[]
  recommendation: string
}

export function assessSafety(
  extraction: ExtractionResult,
  systemData?: Parameters<typeof crossValidateFields>[1]
): SafetyAssessment {
  const gates = checkExecutionGates(extraction)
  const fieldValidation = validateHighRiskFields(extraction.extracted_fields)
  const crossVals = systemData ? crossValidateFields(extraction.extracted_fields, systemData) : []

  const allGatesOk = allGatesPassed(gates)
  const fieldsOk = fieldValidation.valid
  const crossValsOk = crossVals.every(v => v.severity !== 'error')

  let maxLevel: SafetyLevel = 'L1'
  let recommendation = ''

  if (allGatesOk && fieldsOk && crossValsOk) {
    maxLevel = 'L2' // 允许自动生成草稿
    recommendation = '✅ 安全评估通过，可自动生成草稿，需责任人确认后正式执行'
  } else if (allGatesOk && !fieldsOk) {
    maxLevel = 'L1' // 只允许低风险
    recommendation = '⚠️ 高风险字段有问题，仅允许低风险动作自动执行，其余需人工确认'
  } else {
    maxLevel = 'L1'
    recommendation = '❌ 未通过安全门槛，所有动作需人工确认后执行'
  }

  return {
    overall_safe: allGatesOk && fieldsOk,
    max_allowed_level: maxLevel,
    gates,
    field_issues: fieldValidation.issues,
    cross_validations: crossVals,
    recommendation,
  }
}
