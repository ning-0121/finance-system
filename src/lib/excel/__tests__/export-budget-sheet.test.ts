// ============================================================
// export-budget-sheet.ts 单元测试
// 覆盖：
//   1. 预算表公式正确性（USD 订单汇率换算、毛利润、毛利率、收入=0 防 NaN）
//   2. 决算单优先使用 cost_items 实际成本（无降级说明行）
//   3. cost_items 缺失时 fallback 并在行中标注"使用预算成本估算"
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  computeFinancials,
  synthesizeCostItems,
  buildExportRows,
} from '../export-budget-sheet'
import type { BudgetOrder } from '@/lib/types'
import type { CostItemRow } from '../export-budget-sheet'

// ── 测试用 BudgetOrder 工厂 ───────────────────────────────────
function makeOrder(overrides: Partial<BudgetOrder> = {}): BudgetOrder {
  return {
    id: 'test-001',
    order_no: 'QM-2026-001',
    customer_id: 'cust-1',
    customer: { id: 'cust-1', name: '测试客户', company: 'Test Co', contact: null,
      email: null, phone: null, country: null, currency: 'USD', credit_limit: null,
      notes: null, created_at: '2026-01-01' },
    order_date: '2026-05-01',
    delivery_date: '2026-06-01',
    items: [],
    target_purchase_price: 0,
    estimated_freight: 0,
    estimated_commission: 0,
    estimated_customs_fee: 0,
    other_costs: 0,
    total_revenue: 10000,   // USD
    total_cost: 0,
    estimated_profit: 0,
    estimated_margin: 0,
    currency: 'USD',
    exchange_rate: 7.2,
    version: 1,
    status: 'approved',
    created_by: 'user-1',
    approved_by: null,
    approved_at: null,
    notes: null,
    attachments: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

// ══════════════════════════════════════════════════════════════
// 测试 1：预算表公式正确性
// ══════════════════════════════════════════════════════════════
describe('Test 1 — computeFinancials 公式正确性', () => {
  it('USD 订单：收入乘以汇率换算为 CNY，毛利润 = 收入CNY - 成本，毛利率 = 毛利润 / 收入CNY', () => {
    // 收入 10000 USD × 汇率 7.2 = 72000 CNY
    // 成本 50000 CNY
    // 毛利润 = 72000 - 50000 = 22000
    // 毛利率 = 22000 / 72000 × 100 ≈ 30.56%
    const fin = computeFinancials(10000, 50000, 7.2, false)

    expect(fin.revenueCNY).toBe(72000)
    expect(fin.totalCost).toBe(50000)
    expect(fin.profit).toBe(22000)
    expect(fin.margin).toBeCloseTo(30.56, 1)
  })

  it('CNY 订单：收入不乘汇率', () => {
    // 收入 100000 CNY（isCNY = true），汇率无关
    const fin = computeFinancials(100000, 70000, 7.5, true)

    expect(fin.revenueCNY).toBe(100000)
    expect(fin.profit).toBe(30000)
    expect(fin.margin).toBeCloseTo(30, 1)
  })

  it('收入为 0 时：毛利率返回 0，不出现 NaN 或 Infinity', () => {
    const fin = computeFinancials(0, 5000, 7.2, false)

    expect(fin.revenueCNY).toBe(0)
    expect(fin.margin).toBe(0)
    expect(Number.isNaN(fin.margin)).toBe(false)
    expect(Number.isFinite(fin.margin)).toBe(true)
  })

  it('亏损订单：毛利润为负数，毛利率为负数', () => {
    // 收入 5000 USD × 7 = 35000 CNY，成本 40000 CNY → 亏损 5000
    const fin = computeFinancials(5000, 40000, 7, false)

    expect(fin.profit).toBe(-5000)
    expect(fin.margin).toBeLessThan(0)
  })
})

// ══════════════════════════════════════════════════════════════
// 测试 2：决算单优先使用 cost_items 实际成本（costSource=actual）
// ══════════════════════════════════════════════════════════════
describe('Test 2 — 决算单使用实际成本（costSource=actual）', () => {
  it('rows 中不含降级说明行', () => {
    const order = makeOrder({ total_revenue: 8000, exchange_rate: 7.2 })
    const actualCostItems: CostItemRow[] = [
      { date: '05/10', description: '面料-实际', supplier: '义乌布行', unit: '米', qty: 500, unitPrice: 20, amount: 10000 },
      { date: '05/12', description: '加工费-实际', supplier: '三源制衣', amount: 8000 },
    ]

    const { rows } = buildExportRows(order, actualCostItems, 'settlement', 'actual', '2026-05-11')

    // 验证：所有行中不含降级说明文本
    const allCellTexts = rows.flatMap(row => row.map(cell => String(cell ?? '')))
    const hasFallbackNote = allCellTexts.some(t => t.includes('使用预算成本估算'))
    expect(hasFallbackNote).toBe(false)
  })

  it('成本合计正确（实际 cost_items 之和）', () => {
    const order = makeOrder({ total_revenue: 8000, exchange_rate: 7 })
    const actualCostItems: CostItemRow[] = [
      { description: '面料', amount: 10000 },
      { description: '加工', amount: 8000 },
      { description: '运费', amount: 2000 },
    ]

    const { financials } = buildExportRows(order, actualCostItems, 'settlement', 'actual', '2026-05-11')

    // 成本合计 = 10000 + 8000 + 2000 = 20000
    expect(financials.totalCost).toBe(20000)
    // 收入 CNY = 8000 × 7 = 56000
    expect(financials.revenueCNY).toBe(56000)
    // 毛利润 = 56000 - 20000 = 36000
    expect(financials.profit).toBe(36000)
  })

  it('预算表（type=budget）也不含降级说明行', () => {
    const order = makeOrder()
    const synth: CostItemRow[] = [{ description: '面料', amount: 5000 }]

    const { rows } = buildExportRows(order, synth, 'budget', 'estimated', '2026-05-11')

    const allTexts = rows.flatMap(row => row.map(c => String(c ?? '')))
    // 预算表即使 costSource=estimated 也不应出现降级说明（降级说明仅对决算单）
    expect(allTexts.some(t => t.includes('使用预算成本估算'))).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════
// 测试 3：cost_items 缺失时 fallback，Excel 中标注
// ══════════════════════════════════════════════════════════════
describe('Test 3 — 决算单降级（costSource=estimated）时标注备注', () => {
  it('rows 中含有降级说明行', () => {
    const order = makeOrder()
    const synth = synthesizeCostItems(order)  // 合成成本（空，因 order 所有成本字段=0）

    const { rows } = buildExportRows(order, synth, 'settlement', 'estimated', '2026-05-11')

    const allTexts = rows.flatMap(row => row.map(c => String(c ?? '')))
    expect(allTexts.some(t => t.includes('使用预算成本估算'))).toBe(true)
    expect(allTexts.some(t => t.includes('cost_items'))).toBe(true)
  })

  it('synthesizeCostItems 从 _cost_breakdown 提取成本项', () => {
    const order = makeOrder({
      items: [{
        product_name: '女装连衣裙',
        sku: 'SKU-001',
        qty: 1000,
        unit: '件',
        unit_price: 10,
        amount: 10000,
        _cost_breakdown: {
          fabric: 30000,
          accessory: 5000,
          processing: 15000,
          forwarder: 8000,
          container: 3000,
          logistics: 4000,
          extras: [{ name: '检测费', amount: 2000 }],
        },
      } as unknown as import('@/lib/types').OrderItem],
    })

    const rows = synthesizeCostItems(order)
    const descs = rows.map(r => r.description)
    const amounts = rows.map(r => r.amount)

    expect(descs).toContain('面料')
    expect(descs).toContain('辅料')
    expect(descs).toContain('加工费')
    expect(descs).toContain('货代费')
    expect(descs).toContain('装柜费')
    expect(descs).toContain('物流费')
    expect(descs).toContain('检测费')   // extras

    expect(amounts).toContain(30000)
    expect(amounts).toContain(5000)
    expect(amounts).toContain(15000)
    expect(amounts).toContain(2000)

    // 合计应等于所有成本之和
    const total = rows.reduce((s, r) => s + r.amount, 0)
    expect(total).toBe(30000 + 5000 + 15000 + 8000 + 3000 + 4000 + 2000)
  })

  it('synthesizeCostItems 按类别明细行(lines)展开，含 数量/单位/单价', () => {
    const order = makeOrder({
      items: [{
        product_name: '短裤套装', sku: 'SKU-002', qty: 1500, unit: '件', unit_price: 41.8, amount: 62700,
        _cost_breakdown: {
          fabric: 14813.4,   // 类别汇总（应被明细覆盖）
          accessory: 845.25,
          lines: {
            fabric: [{ name: '黑纱', qty: 705.4, unit: 'kg', unit_price: 21, amount: 14813.4 }],
            accessory: [
              { name: '拉链', qty: 1552, unit: '条', unit_price: 0.62, amount: 962 },
              { name: '吊牌', qty: 3381, unit: '套', unit_price: 0.25, amount: 845.25 },
            ],
          },
        },
      } as unknown as import('@/lib/types').OrderItem],
    })

    const rows = synthesizeCostItems(order)

    // 面料：一行明细，带 数量/单位/单价
    const fabricLine = rows.find(r => r.description === '黑纱')
    expect(fabricLine).toBeDefined()
    expect(fabricLine!.qty).toBe(705.4)
    expect(fabricLine!.unit).toBe('kg')
    expect(fabricLine!.unitPrice).toBe(21)
    expect(fabricLine!.amount).toBeCloseTo(14813.4, 1)

    // 辅料：两行明细分别展开，而非合并成一行汇总
    expect(rows.filter(r => r.description === '拉链' || r.description === '吊牌')).toHaveLength(2)
    // 不应再出现裸的"辅料"汇总行（已被明细取代）
    expect(rows.find(r => r.description === '辅料')).toBeUndefined()
  })

  it('synthesizeCostItems 某类别无 lines 时仍退回单行汇总', () => {
    const order = makeOrder({
      items: [{
        product_name: 'x', sku: 'x', qty: 1, unit: '件', unit_price: 1, amount: 1,
        _cost_breakdown: {
          processing: 24000,                 // 无 lines → 单行汇总
          lines: { fabric: [{ name: '黑纱', qty: 100, unit: 'kg', unit_price: 21, amount: 2100 }] },
          fabric: 2100,
        },
      } as unknown as import('@/lib/types').OrderItem],
    })
    const rows = synthesizeCostItems(order)
    expect(rows.find(r => r.description === '加工费')?.amount).toBe(24000)
    expect(rows.find(r => r.description === '黑纱')?.amount).toBe(2100)
  })

  it('synthesizeCostItems 无 _cost_breakdown 时降级到汇总字段', () => {
    const order = makeOrder({
      target_purchase_price: 20000,
      estimated_freight: 5000,
      estimated_commission: 1000,
      estimated_customs_fee: 2000,
      other_costs: 500,
      items: [],   // 无 _cost_breakdown
    })

    const rows = synthesizeCostItems(order)
    const descs = rows.map(r => r.description)

    expect(descs).toContain('采购成本')
    expect(descs).toContain('运费')
    expect(descs).toContain('佣金')
    expect(descs).toContain('报关费')
    expect(descs).toContain('其他费用')

    const total = rows.reduce((s, r) => s + r.amount, 0)
    expect(total).toBe(20000 + 5000 + 1000 + 2000 + 500)
  })
})
