/**
 * 客户扣款(2026-08-05)—— 应收的第三类处置,既不是收款也不是改合同。
 *
 * 业务实证:1022852(年年旺)应收 ¥222,750,客人付 ¥100,710,扣款 ¥122,040。
 * 此前系统只有两个按钮,用哪个都会把账做错:
 *   · 「核销」造一笔假回款流水 → 已收从 10 万虚增到 22 万,回款率虚高,银行对账多一笔;
 *   · 「修正应收金额」改小合同额 → 扣了多少、为什么扣,永远查不到。
 *
 * 正确口径:应收余额 = 合同额 − 已收 − 扣款。扣款单独成账,不进已收。
 */

export const DEDUCTION_TYPES = [
  { key: 'quality_claim',  label: '质量索赔',   defaultTreatment: 'reduce_revenue' },
  { key: 'short_ship',     label: '短装/少发',  defaultTreatment: 'reduce_revenue' },
  { key: 'discount',       label: '协商折让',   defaultTreatment: 'reduce_revenue' },
  { key: 'late_penalty',   label: '迟交罚款',   defaultTreatment: 'expense' },
  { key: 'freight_deduct', label: '代扣运费',   defaultTreatment: 'expense' },
  { key: 'other',          label: '其他',       defaultTreatment: 'expense' },
] as const

export type DeductionType = typeof DEDUCTION_TYPES[number]['key']
export type Treatment = 'reduce_revenue' | 'expense'

export const TREATMENT_LABEL: Record<Treatment, string> = {
  reduce_revenue: '冲减收入（销售折让）',
  expense: '计入费用（不影响收入）',
}
export const TREATMENT_HINT: Record<Treatment, string> = {
  reduce_revenue: '收入减少，毛利率随之下降 —— 适用于质量索赔、短装、协商折让。',
  expense: '收入不变，另计一笔费用 —— 适用于迟交罚款、客户代扣的运费等。',
}

const num = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100

export interface DeductionRow {
  id: string
  budget_order_id: string
  amount_original: number
  currency: string
  exchange_rate: number
  amount_cny: number
  deduction_type: DeductionType
  treatment: Treatment
  reason: string
  occurred_at: string
  voided_at?: string | null
}

/** 某订单的有效扣款合计(CNY) */
export function deductionTotalCny(rows: DeductionRow[] | null | undefined): number {
  return r2((rows || []).filter(d => !d.voided_at).reduce((s, d) => s + num(d.amount_cny), 0))
}

/** 按处理方式拆分 —— 冲减收入的那部分要从收入里扣,计入费用的那部分不动收入 */
export function splitByTreatment(rows: DeductionRow[] | null | undefined) {
  const live = (rows || []).filter(d => !d.voided_at)
  const reduceRevenue = r2(live.filter(d => d.treatment === 'reduce_revenue').reduce((s, d) => s + num(d.amount_cny), 0))
  const expense = r2(live.filter(d => d.treatment === 'expense').reduce((s, d) => s + num(d.amount_cny), 0))
  return { reduceRevenue, expense, total: r2(reduceRevenue + expense) }
}

export interface ArBalanceInput {
  contractCny: number
  receivedCny: number
  deductions?: DeductionRow[] | null
}

export interface ArBalance {
  contractCny: number
  receivedCny: number
  deductionCny: number
  /** 应收余额 = 合同 − 已收 − 扣款。这才是真正还能收回来的钱 */
  balanceCny: number
  /** 已收占合同的比例 —— 分母【不】剔除扣款,反映实际现金回收 */
  collectedPct: number
  /** 结清:余额 ≤ 1 分钱 */
  settled: boolean
}

/**
 * 应收余额计算 —— 全站唯一口径。
 * ⚠️ 扣款【不计入已收】:客人确实没付这笔钱。把扣款算进已收会让回款率失真,
 *    也会让银行对账凭空多出一笔没有进账的流水(这正是「核销」按钮的做法,不要沿用)。
 */
export function computeArBalance(input: ArBalanceInput): ArBalance {
  const contractCny = r2(num(input.contractCny))
  const receivedCny = r2(num(input.receivedCny))
  const deductionCny = deductionTotalCny(input.deductions)
  const balanceCny = r2(contractCny - receivedCny - deductionCny)
  return {
    contractCny, receivedCny, deductionCny,
    balanceCny,
    collectedPct: contractCny > 0 ? r2((receivedCny / contractCny) * 100) : 0,
    settled: balanceCny <= 0.01,
  }
}

/** 表单校验:扣款不能超过当前未收余额,否则应收会变成负数 */
export function validateDeduction(p: {
  amountOriginal: number
  currency: string
  exchangeRate: number
  outstandingCny: number
  reason: string
  occurredAt: string
}): { ok: true; amountCny: number } | { ok: false; error: string } {
  if (!(p.amountOriginal > 0)) return { ok: false, error: '扣款金额必须大于 0' }
  const isCny = String(p.currency || 'CNY').toUpperCase() === 'CNY'
  if (!isCny && !(p.exchangeRate > 0)) return { ok: false, error: '外币扣款必须填汇率，系统不会按 1:1 折算' }
  if (!p.reason.trim()) return { ok: false, error: '请填写扣款原因（扣了什么、依据是什么）' }
  if (!p.occurredAt) return { ok: false, error: '请填写扣款发生日期' }
  const amountCny = r2(p.amountOriginal * (isCny ? 1 : p.exchangeRate))
  if (amountCny > r2(p.outstandingCny) + 0.01) {
    return { ok: false, error: `扣款 ¥${amountCny.toLocaleString()} 超过当前未收余额 ¥${r2(p.outstandingCny).toLocaleString()}，应收会变成负数` }
  }
  return { ok: true, amountCny }
}
