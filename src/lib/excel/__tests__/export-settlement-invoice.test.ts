/**
 * 决算核算单 exporter — 单测
 * 用 vitest run（不依赖 DB，纯函数测试）
 */
import { describe, it, expect } from 'vitest'
import {
  buildSettlementBundle,
  buildSettlementRows,
  synthesizeExpensesFromBudget,
} from '../export-settlement-invoice'
import type { BudgetOrder } from '@/lib/types'

const baseOrder = {
  id: 'test-order-1',
  order_no: 'PO33301961',
  customer_name: 'S2',
  product_name: '瑜伽裤',
  items: [{ quantity: 25680, _cost_breakdown: { fabric: 197328, processing: 160500, accessory: 3465 } }],
  total_revenue: 79608,
  currency: 'USD',
  exchange_rate: 6.82,
  status: 'approved',
} as unknown as BudgetOrder & { product_name: string; customer_name: string }

describe('buildSettlementBundle', () => {
  it('happy: 回款 + 成本聚合 + 计算正确', () => {
    const receipts = [{
      invoice_date: '2026-04-28',
      total_amount: 79608, currency: 'USD',
      exchange_rate: 6.82,
      supplier_name: 'jojo fashion',
      invoice_no: null,
    }]
    const expenses = [
      // 包装组：龙太制衣 包装袋 + 中包袋
      { cost_type: 'packaging', description: '包装袋', supplier: '龙太制衣', cost_group: '包装袋', quantity: 26100, unit: '只', unit_price: 0.1, amount: 2610, currency: 'CNY', exchange_rate: 1, created_at: '2026-03-11' },
      { cost_type: 'packaging', description: '中包袋', supplier: '龙太制衣', cost_group: '包装袋', quantity: 4500, unit: '只', unit_price: 0.19, amount: 855, currency: 'CNY', exchange_rate: 1, created_at: '2026-03-11' },
      // 加工费
      { cost_type: 'processing', description: 'BPLF479', supplier: '傲狐服饰', cost_group: '加工费', quantity: 12840, unit: '件', unit_price: 6.0, amount: 77040, currency: 'CNY', exchange_rate: 1, created_at: '2026-03-20' },
      { cost_type: 'processing', description: 'BPLF480', supplier: '傲狐服饰', cost_group: '加工费', quantity: 12840, unit: '件', unit_price: 6.5, amount: 83460, currency: 'CNY', exchange_rate: 1, created_at: '2026-03-20' },
    ]

    const bundle = buildSettlementBundle(baseOrder as never, receipts, expenses, '2026-03-20')

    expect(bundle.header.order_no).toBe('PO33301961')
    expect(bundle.header.customer_name).toBe('S2')
    expect(bundle.header.product_name).toBe('瑜伽裤')
    expect(bundle.header.quantity).toBe(25680)
    expect(bundle.header.completed_at).toBe('2026年3月20日')
    expect(bundle.meta.cost_source).toBe('actual')
    expect(bundle.meta.receipt_source).toBe('actual')

    // 收：1 行
    expect(bundle.receipts).toHaveLength(1)
    expect(bundle.receipts[0].usd).toBe(79608)
    expect(bundle.receipts[0].cny).toBeCloseTo(542926.56, 2) // 79608 * 6.82

    // 支：4 行，包装组2 + 加工组2
    expect(bundle.expenses).toHaveLength(4)
    // 包装组 最后一行（中包袋）应携带 group_note
    const packagingRows = bundle.expenses.filter(e => e.group === '包装袋')
    const packagingNote = packagingRows[packagingRows.length - 1].group_note
    expect(packagingNote).toBe('包装袋3465元') // 2610+855
    // 加工组 最后一行 group_note
    const procRows = bundle.expenses.filter(e => e.group === '加工费')
    const procNote = procRows[procRows.length - 1].group_note
    expect(procNote).toBe('加工费160500元') // 77040+83460
  })

  it('empty: 无回款 + 无 cost_items → pending + estimated 标记', () => {
    const bundle = buildSettlementBundle(baseOrder as never, [], [], null)
    expect(bundle.meta.receipt_source).toBe('pending')
    expect(bundle.meta.cost_source).toBe('estimated')
    expect(bundle.receipts).toHaveLength(0)
    expect(bundle.expenses).toHaveLength(0)
  })

  it('synthesizeExpensesFromBudget 从 _cost_breakdown 合成', () => {
    const synth = synthesizeExpensesFromBudget(baseOrder)
    expect(synth.length).toBeGreaterThan(0)
    const fabric = synth.find(s => s.cost_group === '面料')
    expect(fabric?.amount).toBe(197328)
    expect(fabric?.description).toContain('预算估算')
  })
})

describe('buildSettlementRows', () => {
  it('rows 输出包含标题、头部块、收/支/合计/毛利', () => {
    const bundle = buildSettlementBundle(
      baseOrder as never,
      [{ invoice_date: '2026-04-28', total_amount: 79608, currency: 'USD', exchange_rate: 6.82, supplier_name: 'jojo', invoice_no: null }],
      [{ cost_type: 'processing', description: '加工', supplier: '傲狐', cost_group: '加工', quantity: 100, unit: '件', unit_price: 6, amount: 600, currency: 'CNY', exchange_rate: 1, created_at: '2026-03-20' }],
      '2026-03-20',
    )
    const { rows, merges } = buildSettlementRows(bundle)

    // 至少：3 标题 + 6 头部 + 1 收header + 1 收数据 + 1 收合计 + 1 支header + 1 支数据 + 1 支合计 + 1 毛利 + 1 毛利率 = 18
    expect(rows.length).toBeGreaterThanOrEqual(17)
    expect(rows[0][0]).toBe('义乌市绮陌服饰有限公司')
    expect(rows[2][0]).toBe('订单核算单')
    expect(rows[3][0]).toBe('订单号')
    expect(rows[3][1]).toBe('PO33301961')
    expect(rows[4][1]).toBe('S2')
    expect(rows[5][1]).toBe('瑜伽裤')

    // 找到 收 header（A=='收'）行
    const shouHeaderIdx = rows.findIndex(r => r[0] === '收')
    expect(shouHeaderIdx).toBeGreaterThan(0)
    expect(rows[shouHeaderIdx][1]).toBe('时间')
    expect(rows[shouHeaderIdx][5]).toBe('美金')
    expect(rows[shouHeaderIdx][6]).toBe('汇率')

    // 找到 支 header
    const zhiHeaderIdx = rows.findIndex(r => r[0] === '支')
    expect(zhiHeaderIdx).toBeGreaterThan(0)
    expect(rows[zhiHeaderIdx][3]).toBe('供应商')
    expect(rows[zhiHeaderIdx][6]).toBe('单价')

    // merges 包含 标题3行（每行A-I合并）+ 头部6行B-I合并
    expect(merges.length).toBeGreaterThanOrEqual(3 + 6)

    // 毛利润、毛利率行存在
    const profitRow = rows.find(r => r[2] === '毛利润')
    const marginRow = rows.find(r => r[2] === '毛利率')
    expect(profitRow).toBeDefined()
    expect(marginRow).toBeDefined()
  })
})
