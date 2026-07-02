import { describe, it, expect } from 'vitest'
import { toChineseUppercase } from '../chinese-amount'

describe('toChineseUppercase 金额大写（财务规范）', () => {
  it('整万/整亿末节不残留「零元」', () => {
    expect(toChineseUppercase(10000)).toBe('壹万元整')
    expect(toChineseUppercase(20000)).toBe('贰万元整')
    expect(toChineseUppercase(50000)).toBe('伍万元整')
    expect(toChineseUppercase(660000)).toBe('陆拾陆万元整')
    expect(toChineseUppercase(1000000)).toBe('壹佰万元整')
    expect(toChineseUppercase(100000000)).toBe('壹亿元整')
  })

  it('中间的零正常保留', () => {
    expect(toChineseUppercase(10001)).toBe('壹万零壹元整')
    expect(toChineseUppercase(100500)).toBe('壹拾万零伍佰元整')
  })

  it('纯小数不加前导零', () => {
    expect(toChineseUppercase(0.05)).toBe('伍分')
    expect(toChineseUppercase(0.5)).toBe('伍角整')
    expect(toChineseUppercase(0.55)).toBe('伍角伍分')
  })

  it('元 + 角分组合', () => {
    expect(toChineseUppercase(8.05)).toBe('捌元零伍分')
    expect(toChineseUppercase(123.45)).toBe('壹佰贰拾叁元肆角伍分')
    expect(toChineseUppercase(100.5)).toBe('壹佰元伍角整')
  })

  it('零与负数', () => {
    expect(toChineseUppercase(0)).toBe('零元整')
    expect(toChineseUppercase(-10000)).toBe('负壹万元整')
  })
})
