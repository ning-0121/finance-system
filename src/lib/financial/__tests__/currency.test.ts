import { describe, it, expect } from 'vitest'
import { normalizeCurrency, currencyForBudget, VALID_CURRENCIES } from '../currency'

describe('normalizeCurrency —— 治「RMB 建单被 chk_currency_valid 拒」', () => {
  it('RMB → CNY(2026-08-08 生产实证的形态)', () => {
    expect(normalizeCurrency('RMB')).toBe('CNY')
    expect(normalizeCurrency('rmb')).toBe('CNY')
    expect(normalizeCurrency(' RMB ')).toBe('CNY')
    expect(normalizeCurrency('人民币')).toBe('CNY')
  })
  it('合法币种原样通过(含小写)', () => {
    for (const c of VALID_CURRENCIES) expect(normalizeCurrency(c)).toBe(c)
    expect(normalizeCurrency('usd')).toBe('USD')
  })
  it('常见别名', () => {
    expect(normalizeCurrency('US$')).toBe('USD')
    expect(normalizeCurrency('美金')).toBe('USD')
    expect(normalizeCurrency('HK$')).toBe('HKD')
  })
  it('认不出返回 null,不猜', () => {
    expect(normalizeCurrency('AUD')).toBeNull()
    expect(normalizeCurrency('比特币')).toBeNull()
  })
  it('空值返回 null', () => {
    expect(normalizeCurrency('')).toBeNull()
    expect(normalizeCurrency(null)).toBeNull()
    expect(normalizeCurrency(undefined)).toBeNull()
  })
})

describe('currencyForBudget —— 建单路径', () => {
  it('空值给默认', () => {
    expect(currencyForBudget('', 'USD')).toBe('USD')
    expect(currencyForBudget(null, 'CNY')).toBe('CNY')
  })
  it('RMB 归一为 CNY,不再打到数据库约束', () => {
    expect(currencyForBudget('RMB', 'USD')).toBe('CNY')
  })
  it('认不出抛可读错误(替代约束的天书报错),绝不静默换币', () => {
    expect(() => currencyForBudget('AUD', 'USD')).toThrow(/不支持的币种「AUD」/)
  })
})
