// ============================================================
// 订单预算表 / 决算单导出 — 义乌市绮陌服饰有限公司标准格式
// 9列布局：A=收/支标签  B=时间/图片  C-D=款号/摘要  E=供应商
//          F=单位  G=数量  H=单价(USD/CNY)  I=金额/备注
// ============================================================

import * as XLSX from 'xlsx'
import type { BudgetOrder, OrderItem } from '@/lib/types'

// ── 公司信息 ─────────────────────────────────────────────────
const COMPANY_CN = '义乌市绮陌服饰有限公司'
const COMPANY_EN = 'YIWU QIMO CLOTHING CO.,LTD'

// ── 成本明细行 ───────────────────────────────────────────────
export interface CostItemRow {
  date?: string
  description: string
  supplier?: string
  unit?: string
  qty?: number | null
  unitPrice?: number | null
  amount: number   // CNY
}

// ── 财务汇总结果（纯函数，方便单测）────────────────────────
export interface ExportFinancials {
  revenueCNY: number   // 收入折合人民币
  totalCost: number    // 成本合计(CNY)
  profit: number       // 毛利润(CNY)  =  revenueCNY - totalCost
  margin: number       // 毛利率(%)，收入为 0 时返回 0 不出 NaN
}

/**
 * 纯函数：计算财务汇总。
 * 收入为 USD 时乘以汇率换算为 CNY；margin 在 revenueCNY=0 时安全返回 0。
 */
export function computeFinancials(
  totalRevenueInOrderCurrency: number,
  totalCostCNY: number,
  exchangeRate: number,
  isCNY: boolean
): ExportFinancials {
  const revenueCNY = isCNY
    ? Math.round(totalRevenueInOrderCurrency * 100) / 100
    : Math.round(totalRevenueInOrderCurrency * exchangeRate * 100) / 100
  const profit = Math.round((revenueCNY - totalCostCNY) * 100) / 100
  const margin = revenueCNY > 0
    ? Math.round((profit / revenueCNY) * 10000) / 100
    : 0
  return { revenueCNY, totalCost: totalCostCNY, profit, margin }
}

/**
 * 从 order._cost_breakdown 合成预算成本明细（纯函数，可单测）。
 * 预算表始终调用此函数；决算表在 cost_items 无数据时降级调用。
 */
export function synthesizeCostItems(order: BudgetOrder): CostItemRow[] {
  const breakdown = (order.items as unknown as Record<string, unknown>[])?.[0]
    ?._cost_breakdown as Record<string, unknown> | undefined

  if (!breakdown) {
    // 无细分：退回 BudgetOrder 汇总字段
    const rows: CostItemRow[] = []
    if ((order.target_purchase_price ?? 0) > 0)
      rows.push({ description: '采购成本', amount: order.target_purchase_price })
    if ((order.estimated_freight ?? 0) > 0)
      rows.push({ description: '运费', amount: order.estimated_freight })
    if ((order.estimated_commission ?? 0) > 0)
      rows.push({ description: '佣金', amount: order.estimated_commission })
    if ((order.estimated_customs_fee ?? 0) > 0)
      rows.push({ description: '报关费', amount: order.estimated_customs_fee })
    if ((order.other_costs ?? 0) > 0)
      rows.push({ description: '其他费用', amount: order.other_costs })
    return rows
  }

  const rows: CostItemRow[] = []
  const n = (key: string) => Number(breakdown[key] ?? 0)

  if (n('fabric') > 0)     rows.push({ description: '面料',   amount: n('fabric') })
  if (n('accessory') > 0)  rows.push({ description: '辅料',   amount: n('accessory') })
  if (n('processing') > 0) rows.push({ description: '加工费', amount: n('processing') })
  if (n('forwarder') > 0)  rows.push({ description: '货代费', amount: n('forwarder') })
  if (n('container') > 0)  rows.push({ description: '装柜费', amount: n('container') })
  if (n('logistics') > 0)  rows.push({ description: '物流费', amount: n('logistics') })

  const extras = breakdown['extras'] as { name: string; amount: number }[] | undefined
  if (Array.isArray(extras)) {
    for (const e of extras) {
      if ((e.amount ?? 0) > 0) rows.push({ description: e.name || '其他', amount: e.amount })
    }
  }
  return rows
}

// ── 行数据 Cell 类型 ─────────────────────────────────────────
type Cell = string | number | null

/**
 * 构建 AOA 行数组（纯函数，无 XLSX/IO 依赖，方便单测）。
 *
 * 返回：
 *   rows      — 9列 AOA 数据，可直接传 XLSX.utils.aoa_to_sheet
 *   financials — 财务汇总（方便测试验证公式）
 *
 * 行结构（固定顺序，合并信息通过行索引在调用方计算）：
 *   0  公司名CN
 *   1  公司名EN
 *   2  报表标题
 *   3  信息块（订单号/客户/日期/交期/汇率）
 *   4  空行
 *   5  收 section header
 *   6..5+N  收数据行（N = products.length）
 *   6+N  收合计行
 *   7+N  空行
 *   8+N  支 section header
 *   [8+N+1  降级说明行（仅 type=settlement && costSource=estimated）]
 *   9+N[+1]..9+N[+1]+M-1  支数据行（M = costItems.length）
 *   9+N[+1]+M  支合计行
 *   10+N[+1]+M  空行
 *   11+N[+1]+M  收入合计行
 *   12+N[+1]+M  成本合计行
 *   13+N[+1]+M  毛利润行
 *   14+N[+1]+M  毛利率行
 *   15+N[+1]+M  空行
 *   16+N[+1]+M  签字行
 *   17+N[+1]+M  日期行
 */
export function buildExportRows(
  order: BudgetOrder,
  costItems: CostItemRow[],
  type: 'budget' | 'settlement',
  costSource: 'actual' | 'estimated',
  nowStr: string
): { rows: Cell[][]; financials: ExportFinancials } {
  const rate = order.exchange_rate || 7
  const currency = order.currency || 'USD'
  const isCNY = currency === 'CNY'
  const products: OrderItem[] = order.items || []

  const rows: Cell[][] = []

  // 公司抬头
  rows.push([COMPANY_CN, null, null, null, null, null, null, null, null])
  rows.push([COMPANY_EN, null, null, null, null, null, null, null, null])

  // 报表标题
  rows.push([
    type === 'budget' ? '订  单  预  算  表' : '订  单  决  算  单',
    null, null, null, null, null, null, null, null,
  ])

  // 信息块
  const customer = order.customer?.company || order.customer?.name || '-'
  rows.push([
    `订单号: ${order.order_no}`, null,
    `客户: ${customer}`, null,
    `日期: ${order.order_date || nowStr}`, null,
    `交期: ${order.delivery_date || '-'}`, null,
    `汇率: ${rate}`,
  ])

  // 空行
  rows.push([null, null, null, null, null, null, null, null, null])

  // ── 收 section ──────────────────────────────────────────
  rows.push([
    '收', '图片', '款号/品名', null, '',
    '数量', `单价(${isCNY ? 'CNY' : 'USD'})`, `金额(${isCNY ? 'CNY' : 'USD'})`, '备注',
  ])
  for (const item of products) {
    rows.push([
      '', '', item.product_name || item.sku || '-', null,
      '', item.qty, item.unit_price, item.amount, '',
    ])
  }
  rows.push(['', '', '合计', null, '', '', '', order.total_revenue, ''])

  // 空行
  rows.push([null, null, null, null, null, null, null, null, null])

  // ── 支 section ──────────────────────────────────────────
  rows.push(['支', '时间', '摘要', null, '供应商', '单位', '数量', '单价(CNY)', '金额(CNY)'])

  // 决算单使用估算成本时插入说明行
  if (type === 'settlement' && costSource === 'estimated') {
    rows.push([
      '', '', '⚠ 使用预算成本估算（cost_items 表无实际成本记录）', null,
      '', '', '', '', '',
    ])
  }

  let totalCost = 0
  for (const item of costItems) {
    totalCost += item.amount
    rows.push([
      '', item.date ?? '', item.description, null,
      item.supplier ?? '', item.unit ?? '',
      item.qty ?? '', item.unitPrice ?? '', item.amount,
    ])
  }
  rows.push(['', '', '合计', null, '', '', '', '', totalCost])

  // ── 利润汇总 ────────────────────────────────────────────
  rows.push([null, null, null, null, null, null, null, null, null])

  const fin = computeFinancials(order.total_revenue, totalCost, rate, isCNY)

  rows.push(['', '', `收入合计(${isCNY ? 'CNY' : `USD×${rate}=CNY`})`, null, '', '', '', '', fin.revenueCNY])
  rows.push(['', '', '成本合计(CNY)', null, '', '', '', '', fin.totalCost])
  rows.push(['', '', '毛利润(CNY)  =  收入 − 成本', null, '', '', '', '', fin.profit])
  rows.push(['', '', `毛利率  =  毛利润 ÷ 收入`, null, '', '', '', '', `${fin.margin}%`])

  rows.push([null, null, null, null, null, null, null, null, null])

  // 签字栏
  rows.push(['制表: 方圆', null, null, '审核: Su', null, null, '批准:', null, null])
  rows.push([`日期: ${nowStr}`, null, null, '日期:', null, null, '日期:', null, '（盖章）'])

  return { rows, financials: fin }
}

// ── 根据行数据推导合并规则 ────────────────────────────────────
/** 将 buildExportRows 返回的 rows 转换为 XLSX 合并配置。 */
function buildMerges(
  rows: Cell[][],
  products: OrderItem[],
  costItems: CostItemRow[],
  hasFallbackNote: boolean
): XLSX.Range[] {
  const m: XLSX.Range[] = []
  const N = products.length
  const M = costItems.length
  const fallback = hasFallbackNote ? 1 : 0

  // 全宽合并辅助
  const full = (r: number) => m.push({ s: { r, c: 0 }, e: { r, c: 8 } })
  // C-D 合并辅助
  const cd   = (r: number) => m.push({ s: { r, c: 2 }, e: { r, c: 3 } })
  // C-H 合并（标签行）
  const ch   = (r: number) => m.push({ s: { r, c: 2 }, e: { r, c: 7 } })

  // 公司 / 标题（rows 0-2）
  full(0); full(1); full(2)

  // 信息块（row 3）：A-B / C-D / E-F / G-H 各自合并
  m.push({ s: { r: 3, c: 0 }, e: { r: 3, c: 1 } })
  m.push({ s: { r: 3, c: 2 }, e: { r: 3, c: 3 } })
  m.push({ s: { r: 3, c: 4 }, e: { r: 3, c: 5 } })
  m.push({ s: { r: 3, c: 6 }, e: { r: 3, c: 7 } })

  // 收 section header（row 5）：C-D 合并
  cd(5)
  // 收数据行（rows 6..5+N）：C-D 合并
  for (let i = 0; i < N; i++) cd(6 + i)
  // 收 A 列垂直合并（header 到最后数据行）
  if (N > 0) m.push({ s: { r: 5, c: 0 }, e: { r: 5 + N, c: 0 } })
  // 收合计（row 6+N）：C-D 合并
  const shouTotal = 6 + N
  cd(shouTotal)

  // 支 section header（row 8+N）：C-D 合并
  const zhiHeader = 8 + N
  cd(zhiHeader)
  // 降级说明行（C-I 合并）
  if (hasFallbackNote) {
    m.push({ s: { r: zhiHeader + 1, c: 2 }, e: { r: zhiHeader + 1, c: 8 } })
  }
  // 支数据行：C-D 合并
  const zhiDataStart = zhiHeader + 1 + fallback
  for (let i = 0; i < M; i++) cd(zhiDataStart + i)
  // 支 A 列垂直合并（header 到最后数据行）
  if (M > 0) m.push({ s: { r: zhiHeader, c: 0 }, e: { r: zhiDataStart + M - 1, c: 0 } })
  // 支合计：C-D 合并
  cd(zhiDataStart + M)

  // 利润汇总（C-H 合并标签，I 是数值）
  const summaryStart = zhiDataStart + M + 2  // 支合计 + 空行
  ch(summaryStart)
  ch(summaryStart + 1)
  ch(summaryStart + 2)
  ch(summaryStart + 3)

  // 签字栏
  const signRow = summaryStart + 5
  m.push({ s: { r: signRow, c: 0 }, e: { r: signRow, c: 2 } })
  m.push({ s: { r: signRow, c: 3 }, e: { r: signRow, c: 5 } })
  m.push({ s: { r: signRow, c: 6 }, e: { r: signRow, c: 8 } })
  m.push({ s: { r: signRow + 1, c: 0 }, e: { r: signRow + 1, c: 2 } })
  m.push({ s: { r: signRow + 1, c: 3 }, e: { r: signRow + 1, c: 5 } })
  m.push({ s: { r: signRow + 1, c: 6 }, e: { r: signRow + 1, c: 7 } })

  return m
}

// ── 主导出函数 ───────────────────────────────────────────────
/**
 * @param order       BudgetOrder 对象
 * @param costItems   成本明细行（预算表传合成值，决算表优先传 cost_items 实际值）
 * @param type        'budget' | 'settlement'
 * @param costSource  'actual'（来自 cost_items 表）| 'estimated'（降级合成）
 *                    当 type=settlement && costSource=estimated 时，
 *                    在支区插入标注行"⚠ 使用预算成本估算"。
 */
export function exportBudgetOrSettlementToExcel(
  order: BudgetOrder,
  costItems: CostItemRow[],
  type: 'budget' | 'settlement' = 'budget',
  costSource: 'actual' | 'estimated' = 'actual'
): void {
  const now = new Date()
  const nowStr = now.toLocaleDateString('zh-CN')
  const hasFallbackNote = type === 'settlement' && costSource === 'estimated'

  const { rows } = buildExportRows(order, costItems, type, costSource, nowStr)
  const merges = buildMerges(rows, order.items || [], costItems, hasFallbackNote)

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = merges

  // 列宽
  ws['!cols'] = [
    { wch: 6 },   // A 收/支
    { wch: 10 },  // B 时间/图片
    { wch: 20 },  // C 款号/摘要
    { wch: 6 },   // D (merged with C)
    { wch: 14 },  // E 供应商
    { wch: 8 },   // F 单位
    { wch: 10 },  // G 数量
    { wch: 12 },  // H 单价
    { wch: 14 },  // I 金额
  ]

  // 行高：标题类行更高
  ws['!rows'] = [
    { hpt: 28 },  // row 0 公司名CN
    { hpt: 20 },  // row 1 公司名EN
    { hpt: 26 },  // row 2 报表标题
    { hpt: 20 },  // row 3 信息块
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, type === 'budget' ? '订单预算表' : '订单决算单')

  const safeOrderNo = order.order_no.replace(/[\\/:*?"<>|]/g, '_')
  const dateStr = nowStr.replace(/\//g, '-')
  XLSX.writeFile(wb, `${type === 'budget' ? '预算表' : '决算单'}_${safeOrderNo}_${dateStr}.xlsx`)
}
