import { describe, it, expect } from 'vitest'
import { checkPoApproval } from '../po-approval-gate'

const base = { currency: 'CNY', deductionDeclared: true }

describe('checkPoApproval —— 金额对不上绝对不能过(老板 2026-08-03)', () => {
  it('明细行合计 ≠ 单头 → 拦住,并说清差多少、怎么改', () => {
    // 生产实证形态:PO-20260727-001 行合计 7176 vs 单头 7020
    const r = checkPoApproval({ ...base, headerAmount: 7020, lines: [{ amount: 7176 }] })
    expect(r.canApprove).toBe(false)
    const c = r.checks.find(x => x.id === 'lines_vs_header')!
    expect(c.passed).toBe(false)
    expect(c.detail).toContain('7,176')
    expect(c.detail).toContain('7,020')
    expect(c.detail).toContain('156')
    expect(c.detail).toContain('折让行')   // 要给出可执行的改法,不能只说"不一致"
  })

  it('明细合计 = 单头 → 放行', () => {
    const r = checkPoApproval({ ...base, headerAmount: 7020, lines: [{ amount: 7000 }, { amount: 20 }] })
    expect(r.canApprove).toBe(true)
  })

  it('一分钱以内视为相等(浮点噪声不拦人)', () => {
    const r = checkPoApproval({ ...base, headerAmount: 100, lines: [{ amount: 100.005 }] })
    expect(r.canApprove).toBe(true)
  })

  it('差一分钱就拦(绝对口径,不放水)', () => {
    const r = checkPoApproval({ ...base, headerAmount: 100, lines: [{ amount: 100.01 }] })
    expect(r.canApprove).toBe(false)
  })

  it('没有明细行 → 拦住:财务无从判断钱花在什么上', () => {
    const r = checkPoApproval({ ...base, headerAmount: 5000, lines: [] })
    expect(r.canApprove).toBe(false)
    expect(r.blockers.some(b => b.id === 'lines_present')).toBe(true)
  })
})

describe('供应商对账口径 vs 采购订单口径', () => {
  it('两个口径不一致 → 拦住并点名对不上的行(小吴那张单的形态)', () => {
    const r = checkPoApproval({
      ...base, headerAmount: 1000, lines: [{ amount: 1000 }],
      reconLines: [
        { material_name: '洗标', po_amount: 600, supplier_amount: 600 },
        { material_name: '织带', po_amount: 400, supplier_amount: 550 },
      ],
    })
    expect(r.canApprove).toBe(false)
    const c = r.checks.find(x => x.id === 'supplier_vs_po')!
    expect(c.detail).toContain('150')
    expect(c.detail).toContain('织带')     // 直接点名哪一行,不用人去找不同
    expect(c.detail).not.toContain('洗标')
  })

  it('两个口径一致 → 通过', () => {
    const r = checkPoApproval({
      ...base, headerAmount: 1000, lines: [{ amount: 1000 }],
      reconLines: [{ material_name: '洗标', po_amount: 1000, supplier_amount: 1000 }],
    })
    expect(r.canApprove).toBe(true)
  })
})

describe('扣款显式声明 —— 治「圆圆忘了登记那 ¥1500」', () => {
  it('未声明 → 拦住', () => {
    const r = checkPoApproval({ currency: 'CNY', headerAmount: 100, lines: [{ amount: 100 }], deductionDeclared: false })
    expect(r.canApprove).toBe(false)
    expect(r.blockers.some(b => b.id === 'deduction_declared')).toBe(true)
  })
  it('已声明 → 通过(把「忘记」变成「要主动声明没有」)', () => {
    const r = checkPoApproval({ currency: 'CNY', headerAmount: 100, lines: [{ amount: 100 }], deductionDeclared: true })
    expect(r.canApprove).toBe(true)
  })
})

describe('预算闸门与资料齐备', () => {
  it('关联订单缺预算单 → 拦住(既有规则不变)', () => {
    const r = checkPoApproval({ ...base, headerAmount: 100, lines: [{ amount: 100 }], missingBudgetCount: 2 })
    expect(r.canApprove).toBe(false)
    expect(r.blockers.some(b => b.id === 'budget_exists')).toBe(true)
  })

  it('资料齐备默认【不】校验 —— 否则当前 0 附件会冻结全部在途采购单', () => {
    const r = checkPoApproval({ ...base, headerAmount: 100, lines: [{ amount: 100 }], attachmentCount: 0 })
    expect(r.checks.some(c => c.id === 'attachments')).toBe(false)
    expect(r.canApprove).toBe(true)
  })

  it('显式开启后才校验附件', () => {
    const r = checkPoApproval({ ...base, headerAmount: 100, lines: [{ amount: 100 }], requireAttachments: true, attachmentCount: 0 })
    expect(r.canApprove).toBe(false)
    expect(r.blockers.some(b => b.id === 'attachments')).toBe(true)
  })
})

describe('多项同时不通过 → 全部列出,让人一次改完', () => {
  it('不是只报第一条', () => {
    const r = checkPoApproval({
      currency: 'CNY', headerAmount: 7020, lines: [{ amount: 7176 }],
      reconLines: [{ material_name: '袋子', po_amount: 100, supplier_amount: 130 }],
      missingBudgetCount: 1, deductionDeclared: false,
    })
    expect(r.canApprove).toBe(false)
    expect(r.blockers.map(b => b.id).sort()).toEqual(
      ['budget_exists', 'deduction_declared', 'lines_vs_header', 'supplier_vs_po'].sort()
    )
  })
})

describe('事件驱动待扣款 —— 治「不知道有」(根治手段)', () => {
  const ok = { currency: 'CNY', headerAmount: 100, lines: [{ amount: 100 }], deductionDeclared: true }

  it('有未处理待扣款 → 拦住,并列出是什么事件引发的、扣多少', () => {
    const r = checkPoApproval({
      ...ok,
      pendingDeductions: [
        { amount: 1200, event_type: 'qc_failed', reason: '色差超标 300 件' },
        { amount: 300, event_type: 'material_resupplied', reason: '补拉链' },
      ],
    })
    expect(r.canApprove).toBe(false)
    const c = r.checks.find(x => x.id === 'pending_deductions')!
    expect(c.detail).toContain('2 笔')
    expect(c.detail).toContain('1,500')          // 正是漏登的那 ¥1500 的形态
    expect(c.detail).toContain('验货不合格')
    expect(c.detail).toContain('补原辅料')
    expect(c.detail).toContain('色差超标')
  })

  it('待扣款处理完(列表为空)→ 放行', () => {
    expect(checkPoApproval({ ...ok, pendingDeductions: [] }).canApprove).toBe(true)
  })

  it('勾了「已核对扣款」也挡不住系统已知的待扣款 —— 人的声明不能覆盖事件事实', () => {
    const r = checkPoApproval({ ...ok, deductionDeclared: true, pendingDeductions: [{ amount: 500, event_type: 'rework' }] })
    expect(r.canApprove).toBe(false)
    expect(r.blockers.some(b => b.id === 'pending_deductions')).toBe(true)
  })
})
