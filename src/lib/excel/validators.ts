// ============================================================
// 财务数据验证引擎 — 确保导入数据准确性
// ============================================================

export interface ValidationError {
  row: number
  column: string
  value: unknown
  message: string
}

export function validateRows(
  rows: Record<string, unknown>[],
  rules: ValidationRule[]
): ValidationError[] {
  const errors: ValidationError[] = []

  rows.forEach((row, rowIdx) => {
    rules.forEach(rule => {
      const value = row[rule.field]
      const error = validateField(value, rule, rowIdx + 2) // +2 because row 1 is header

      if (error) {
        errors.push({ ...error, column: rule.label || rule.field })
      }
    })
  })

  return errors
}

interface ValidationRule {
  field: string
  label?: string
  required?: boolean
  type?: 'number' | 'date' | 'string' | 'currency_amount'
  min?: number
  max?: number
  enum?: string[]
}

function validateField(
  value: unknown,
  rule: ValidationRule,
  row: number
): Omit<ValidationError, 'column'> | null {
  // 必填检查
  if (rule.required && (value === null || value === undefined || value === '')) {
    return { row, value, message: `${rule.label || rule.field} 不能为空` }
  }

  if (value === null || value === undefined || value === '') return null

  // 数字类型检查
  if (rule.type === 'number' || rule.type === 'currency_amount') {
    const num = parseNumber(value)
    if (isNaN(num)) {
      return { row, value, message: `${rule.label || rule.field} 必须是有效数字，当前值: "${value}"` }
    }
    if (rule.min !== undefined && num < rule.min) {
      return { row, value, message: `${rule.label || rule.field} 不能小于 ${rule.min}` }
    }
    if (rule.max !== undefined && num > rule.max) {
      return { row, value, message: `${rule.label || rule.field} 不能大于 ${rule.max}` }
    }
  }

  // 日期检查
  if (rule.type === 'date') {
    const date = parseDate(value)
    if (!date) {
      return { row, value, message: `${rule.label || rule.field} 不是有效日期格式` }
    }
  }

  // 枚举检查
  if (rule.enum && !rule.enum.includes(String(value))) {
    return { row, value, message: `${rule.label || rule.field} 的值 "${value}" 不在允许范围内` }
  }

  return null
}

// 解析数字（处理千分位、货币符号等）
export function parseNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return NaN

  // 移除货币符号、空格、千分位逗号
  const cleaned = value
    .replace(/[$€¥£￥]/g, '')
    .replace(/\s/g, '')
    .replace(/,/g, '')
    .trim()

  return parseFloat(cleaned)
}

// 解析日期（支持多种格式）
export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'number') {
    // Excel serial date
    const date = new Date((value - 25569) * 86400 * 1000)
    return isNaN(date.getTime()) ? null : date
  }
  if (typeof value !== 'string') return null

  // 尝试多种格式
  const formats = [
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/,     // YYYY-MM-DD
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/,      // DD/MM/YYYY or MM/DD/YYYY
    /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,          // YYYY年MM月DD日
  ]

  for (const fmt of formats) {
    const m = value.match(fmt)
    if (m) {
      const date = new Date(parseInt(m[1]) > 31 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[1]}-${m[2]}`)
      if (!isNaN(date.getTime())) return date
    }
  }

  const fallback = new Date(value)
  return isNaN(fallback.getTime()) ? null : fallback
}

// 费用导入验证规则
export const COST_IMPORT_RULES: ValidationRule[] = [
  { field: 'description', label: '描述', required: true, type: 'string' },
  { field: 'amount', label: '金额', required: true, type: 'currency_amount', min: 0.01 },
  { field: 'currency', label: '币种', type: 'string', enum: ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'HKD'] },
]

// 将金额精确到2位小数
export function roundAmount(value: number): number {
  return Math.round(value * 100) / 100
}
