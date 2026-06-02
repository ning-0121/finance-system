// 会计通用工具函数
import Decimal from 'decimal.js'

/**
 * 转义 SQL ILIKE 模式中的特殊字符（%, _, \），防止通配符扩大查询范围。
 * 使用方式: .ilike('col', `%${escapeIlike(userInput)}%`)
 */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

// decimal.js 全局配置：28位有效数字，ROUND_HALF_UP
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

/**
 * 安全取汇率：CNY 固定返回 1，外币缺失时警告并返回默认值 7。
 * 在关键会计路径（GL过账、对账、审计）中使用，确保缺失汇率可被追踪。
 */
export function safeRate(
  rate: number | null | undefined,
  currency: string | null | undefined,
  context?: string
): number {
  if (!currency || currency === 'CNY') return 1
  if (rate == null || rate === 0) {
    console.warn(
      `[汇率缺失] ${context ?? '未知位置'}: exchange_rate=${rate}，货币=${currency}，` +
      '使用默认值 7。请在预算单编辑界面补填汇率以确保账目准确。'
    )
    return 7
  }
  return rate
}

/**
 * 严格取汇率：用于「会写入总账」的关键过账路径。
 * CNY 返回 1；外币缺失/为 0 时**抛错**（而非伪造 7），避免把臆测汇率写进账本造成
 * 看似合理实则错误的静默误账。配合非阻塞过账：抛错→该笔不过账并记录告警，
 * 待补填汇率后可幂等重过账。展示/报表等非记账路径仍用 safeRate。
 */
export function requireRate(
  rate: number | null | undefined,
  currency: string | null | undefined,
  context?: string
): number {
  if (!currency || currency === 'CNY') return 1
  if (rate == null || rate === 0) {
    throw new Error(`[汇率缺失] ${context ?? '过账'}: 货币=${currency} 缺少有效汇率，已拒绝过账以防错账。请先在预算单补填汇率后重试。`)
  }
  return rate
}

/**
 * 安全除法：分母为 0、NaN、Infinity 时返回 0，避免 NaN/Infinity 污染报表。
 */
export function safeDivide(numerator: number, denominator: number): number {
  if (!denominator || !isFinite(denominator)) return 0
  const result = numerator / denominator
  return isFinite(result) ? result : 0
}

/**
 * 统一四舍五入：保留两位小数（使用 Decimal.js，避免 IEEE 754 误差）。
 */
export function roundAmount(value: number): number {
  return new Decimal(value).toDecimalPlaces(2).toNumber()
}

/**
 * 精确累加：对多个金额求和，避免浮点累积误差。
 * 适用于 GL 借贷合计、汇兑损益汇总、对账期间汇总等场景。
 */
export function sumAmounts(values: number[]): number {
  return values
    .reduce((acc, v) => acc.plus(new Decimal(v)), new Decimal(0))
    .toDecimalPlaces(2)
    .toNumber()
}

/**
 * 精确乘法：amount × rate，结果保留2位小数。
 * 取代 Math.round(amount * rate * 100) / 100。
 */
export function mulAmount(amount: number, rate: number): number {
  return new Decimal(amount).mul(new Decimal(rate)).toDecimalPlaces(2).toNumber()
}
