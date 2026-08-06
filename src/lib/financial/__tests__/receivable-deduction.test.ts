import { describe, it, expect } from 'vitest'
import {
  computeArBalance, deductionTotalCny, splitByTreatment, validateDeduction,
  DEDUCTION_TYPES, type DeductionRow,
} from '../receivable-deduction'

const d = (p: Partial<DeductionRow>): DeductionRow => ({
  id: 'x', budget_order_id: 'o', amount_original: 0, currency: 'CNY', exchange_rate: 1,
  amount_cny: 0, deduction_type: 'quality_claim', treatment: 'reduce_revenue',
  reason: 'r', occurred_at: '2026-08-05', ...p,
})

describe('应收余额 = 合同 − 已收 − 扣款', () => {
  it('1022852 真实形态:应收 222,750,实收 100,710,扣款 122,040 → 结清', () => {
    const b = computeArBalance({
      contractCny: 222750, receivedCny: 100710,
      deductions: [d({ amount_cny: 122040 })],
    })
    expect(b.deductionCny).toBe(122040)
    expect(b.balanceCny).toBe(0)
    expect(b.settled).toBe(true)
  })

  it('⚠️ 扣款绝不计入已收 —— 客人确实没付这笔钱', () => {
    const b = computeArBalance({
      contractCny: 222750, receivedCny: 100710,
      deductions: [d({ amount_cny: 122040 })],
    })
    expect(b.receivedCny).toBe(100710)               // 不是 222750
    expect(b.collectedPct).toBeCloseTo(45.21, 1)     // 回款率按实收算,不因结清而虚高
  })

  it('无扣款时退化为「合同 − 已收」', () => {
    const b = computeArBalance({ contractCny: 1000, receivedCny: 400 })
    expect(b.balanceCny).toBe(600)
    expect(b.deductionCny).toBe(0)
    expect(b.settled).toBe(false)
  })

  it('已作废的扣款不计入', () => {
    const b = computeArBalance({
      contractCny: 1000, receivedCny: 400,
      deductions: [d({ amount_cny: 600, voided_at: '2026-08-05T00:00:00Z' })],
    })
    expect(b.deductionCny).toBe(0)
    expect(b.balanceCny).toBe(600)
  })

  it('一分钱以内视为结清(浮点容差)', () => {
    expect(computeArBalance({ contractCny: 1000, receivedCny: 999.995 }).settled).toBe(true)
  })
})

describe('按处理方式拆分 —— 冲收入与计费用对利润影响不同', () => {
  it('分别汇总,互不混淆', () => {
    const s = splitByTreatment([
      d({ amount_cny: 1000, treatment: 'reduce_revenue' }),
      d({ amount_cny: 300, treatment: 'expense' }),
      d({ amount_cny: 200, treatment: 'reduce_revenue' }),
    ])
    expect(s.reduceRevenue).toBe(1200)
    expect(s.expense).toBe(300)
    expect(s.total).toBe(1500)
  })
  it('作废的不算', () => {
    expect(splitByTreatment([d({ amount_cny: 999, voided_at: '2026-08-05' })]).total).toBe(0)
  })
})

describe('扣款类型与默认处理', () => {
  it('质量索赔/短装/折让 → 默认冲减收入;罚款/代扣运费 → 默认计入费用', () => {
    const m = Object.fromEntries(DEDUCTION_TYPES.map(t => [t.key, t.defaultTreatment]))
    expect(m.quality_claim).toBe('reduce_revenue')
    expect(m.short_ship).toBe('reduce_revenue')
    expect(m.discount).toBe('reduce_revenue')
    expect(m.late_penalty).toBe('expense')
    expect(m.freight_deduct).toBe('expense')
  })
})

describe('录入校验', () => {
  const base = { currency: 'CNY', exchangeRate: 1, outstandingCny: 122040, reason: '色差索赔', occurredAt: '2026-08-05' }

  it('正常录入通过并算出 CNY', () => {
    const r = validateDeduction({ ...base, amountOriginal: 122040 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.amountCny).toBe(122040)
  })
  it('超过未收余额 → 拒绝(否则应收变负数)', () => {
    const r = validateDeduction({ ...base, amountOriginal: 200000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('超过当前未收余额')
  })
  it('外币缺汇率 → 拒绝,不按 1:1 折算', () => {
    const r = validateDeduction({ ...base, currency: 'USD', exchangeRate: 0, amountOriginal: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('必须填汇率')
  })
  it('外币有汇率 → 按汇率折 CNY', () => {
    const r = validateDeduction({ ...base, currency: 'USD', exchangeRate: 7, amountOriginal: 100, outstandingCny: 1000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.amountCny).toBe(700)
  })
  it('原因必填 —— 事后要能查清扣的什么', () => {
    expect(validateDeduction({ ...base, amountOriginal: 100, reason: '  ' }).ok).toBe(false)
  })
  it('金额必须大于 0', () => {
    expect(validateDeduction({ ...base, amountOriginal: 0 }).ok).toBe(false)
    expect(validateDeduction({ ...base, amountOriginal: -5 }).ok).toBe(false)
  })
})
