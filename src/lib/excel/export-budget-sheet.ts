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

// ── 从 order._cost_breakdown 合成成本明细 ─────────────────────
export function synthesizeCostItems(order: BudgetOrder): CostItemRow[] {
  const breakdown = (order.items as unknown as Record<string, unknown>[])?.[0]
    ?._cost_breakdown as Record<string, unknown> | undefined

  if (!breakdown) {
    // 无细分数据时，用汇总字段
    const rows: CostItemRow[] = []
    if (order.target_purchase_price > 0)
      rows.push({ description: '采购成本', amount: order.target_purchase_price })
    if (order.estimated_freight > 0)
      rows.push({ description: '运费', amount: order.estimated_freight })
    if (order.estimated_commission > 0)
      rows.push({ description: '佣金', amount: order.estimated_commission })
    if (order.estimated_customs_fee > 0)
      rows.push({ description: '报关费', amount: order.estimated_customs_fee })
    if (order.other_costs > 0)
      rows.push({ description: '其他费用', amount: order.other_costs })
    return rows
  }

  const rows: CostItemRow[] = []
  const n = (key: string) => Number(breakdown[key] || 0)

  if (n('fabric') > 0)
    rows.push({ description: '面料', amount: n('fabric') })
  if (n('accessory') > 0)
    rows.push({ description: '辅料', amount: n('accessory') })
  if (n('processing') > 0)
    rows.push({ description: '加工费', amount: n('processing') })
  if (n('forwarder') > 0)
    rows.push({ description: '货代费', amount: n('forwarder') })
  if (n('container') > 0)
    rows.push({ description: '装柜费', amount: n('container') })
  if (n('logistics') > 0)
    rows.push({ description: '物流费', amount: n('logistics') })

  // 其他费用数组
  const extras = breakdown['extras'] as { name: string; amount: number }[] | undefined
  if (Array.isArray(extras)) {
    for (const e of extras) {
      if (e.amount > 0) rows.push({ description: e.name || '其他', amount: e.amount })
    }
  }

  return rows
}

// ── 主导出函数 ───────────────────────────────────────────────
export function exportBudgetOrSettlementToExcel(
  order: BudgetOrder,
  costItems: CostItemRow[],
  type: 'budget' | 'settlement' = 'budget'
): void {
  const now = new Date()
  const nowStr = now.toLocaleDateString('zh-CN')
  const rate = order.exchange_rate || 7
  const customer = order.customer?.company || order.customer?.name || '-'
  const currency = order.currency || 'USD'
  const isCNY = currency === 'CNY'

  // 产品行（收 section）
  const products: OrderItem[] = order.items || []

  // ── 行数据构建 ────────────────────────────────────────────

  // 辅助函数：生成单元格地址
  const cell = (r: number, c: number) => XLSX.utils.encode_cell({ r, c })

  const rows: (string | number | null)[][] = []
  const merges: XLSX.Range[] = []

  let r = 0  // 当前行指针

  // ── 公司抬头 ──────────────────────────────────────────────
  rows.push([COMPANY_CN, null, null, null, null, null, null, null, null])
  merges.push({ s: { r, c: 0 }, e: { r, c: 8 } })
  r++

  rows.push([COMPANY_EN, null, null, null, null, null, null, null, null])
  merges.push({ s: { r, c: 0 }, e: { r, c: 8 } })
  r++

  // ── 报表标题 ──────────────────────────────────────────────
  const title = type === 'budget' ? '订  单  预  算  表' : '订  单  决  算  单'
  rows.push([title, null, null, null, null, null, null, null, null])
  merges.push({ s: { r, c: 0 }, e: { r, c: 8 } })
  r++

  // ── 信息块 ────────────────────────────────────────────────
  rows.push([
    `订单号: ${order.order_no}`, null,
    `客户: ${customer}`, null,
    `日期: ${order.order_date || nowStr}`, null,
    `交期: ${order.delivery_date || '-'}`, null,
    `汇率: ${rate}`,
  ])
  merges.push({ s: { r, c: 0 }, e: { r, c: 1 } })
  merges.push({ s: { r, c: 2 }, e: { r, c: 3 } })
  merges.push({ s: { r, c: 4 }, e: { r, c: 5 } })
  merges.push({ s: { r, c: 6 }, e: { r, c: 7 } })
  r++

  // ── 空行 ─────────────────────────────────────────────────
  rows.push([null, null, null, null, null, null, null, null, null])
  r++

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 收 section
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // 收 section column header
  rows.push(['收', '图片', '款号/品名', null, '', '数量', `单价(${isCNY ? 'CNY' : 'USD'})`, `金额(${isCNY ? 'CNY' : 'USD'})`, '备注'])
  merges.push({ s: { r, c: 2 }, e: { r, c: 3 } })  // 款号/品名 横向合并C-D
  r++

  const shouHeaderRow = r - 1   // 收 header行
  const shouStartRow = r        // 收 数据起始行

  // 产品数据行
  for (const item of products) {
    rows.push([
      '',                          // A: 留空（后面垂直合并"收"）
      '',                          // B: 图片（留空）
      item.product_name || item.sku || '-', // C: 款号/品名
      null,                        // D: 与C合并
      '',                          // E: 空
      item.qty,                    // F: 数量
      item.unit_price,             // G: 单价(USD)
      item.amount,                 // H: 金额(USD)
      '',                          // I: 备注
    ])
    merges.push({ s: { r, c: 2 }, e: { r, c: 3 } })  // C-D合并
    r++
  }

  const shouEndRow = r - 1  // 收 数据最后行

  // 收 合计行
  const totalRevenue = order.total_revenue
  rows.push([
    '',                   // A
    '',                   // B
    '合计', null,         // C-D
    '',                   // E
    '',                   // F 数量不汇总
    '',                   // G 单价
    totalRevenue,         // H 金额合计
    '',                   // I
  ])
  merges.push({ s: { r, c: 2 }, e: { r, c: 3 } })
  r++

  // 垂直合并 A 列（收 header 到最后一个数据行，不含合计行）
  if (products.length > 0) {
    // 在收 section header 的 A 列写 "收"，向下合并到数据末尾
    merges.push({ s: { r: shouHeaderRow, c: 0 }, e: { r: shouEndRow, c: 0 } })
  }

  // 空行
  rows.push([null, null, null, null, null, null, null, null, null])
  r++

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 支 section
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // 支 section column header
  rows.push(['支', '时间', '摘要', null, '供应商', '单位', '数量', '单价(CNY)', '金额(CNY)'])
  merges.push({ s: { r, c: 2 }, e: { r, c: 3 } })
  r++

  const zhiHeaderRow = r - 1
  const zhiStartRow = r

  // 成本数据行
  let totalCost = 0
  for (const item of costItems) {
    totalCost += item.amount
    rows.push([
      '',                          // A: 留空
      item.date || '',             // B: 时间
      item.description,            // C: 摘要
      null,                        // D: 与C合并
      item.supplier || '',         // E: 供应商
      item.unit || '',             // F: 单位
      item.qty ?? '',              // G: 数量
      item.unitPrice ?? '',        // H: 单价
      item.amount,                 // I: 金额
    ])
    merges.push({ s: { r, c: 2 }, e: { r, c: 3 } })
    r++
  }

  const zhiEndRow = r - 1

  // 支 合计行
  rows.push([
    '',              // A
    '',              // B
    '合计', null,    // C-D
    '', '', '',      // E-G
    '',              // H
    totalCost,       // I
  ])
  merges.push({ s: { r, c: 2 }, e: { r, c: 3 } })
  r++

  // 垂直合并 A 列（支 header 到最后数据行）
  if (costItems.length > 0) {
    merges.push({ s: { r: zhiHeaderRow, c: 0 }, e: { r: zhiEndRow, c: 0 } })
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 利润汇总
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  rows.push([null, null, null, null, null, null, null, null, null])
  r++

  // 收入折合人民币
  const revenueCNY = isCNY ? totalRevenue : Math.round(totalRevenue * rate * 100) / 100
  const profit = Math.round((revenueCNY - totalCost) * 100) / 100
  const margin = revenueCNY > 0 ? Math.round((profit / revenueCNY) * 10000) / 100 : 0

  rows.push(['', '', `收入合计(CNY折算)`, null, '', '', '', '', revenueCNY])
  merges.push({ s: { r, c: 2 }, e: { r, c: 7 } })
  r++

  rows.push(['', '', `成本合计(CNY)`, null, '', '', '', '', totalCost])
  merges.push({ s: { r, c: 2 }, e: { r, c: 7 } })
  r++

  rows.push(['', '', `毛利润(CNY)`, null, '', '', '', '', profit])
  merges.push({ s: { r, c: 2 }, e: { r, c: 7 } })
  r++

  rows.push(['', '', `毛利率`, null, '', '', '', '', `${margin}%`])
  merges.push({ s: { r, c: 2 }, e: { r, c: 7 } })
  r++

  // 空行
  rows.push([null, null, null, null, null, null, null, null, null])
  r++

  // ── 签字栏 ───────────────────────────────────────────────
  rows.push(['制表: 方圆', null, null, '审核: Su', null, null, '批准:', null, null])
  merges.push({ s: { r, c: 0 }, e: { r, c: 2 } })
  merges.push({ s: { r, c: 3 }, e: { r, c: 5 } })
  merges.push({ s: { r, c: 6 }, e: { r, c: 8 } })
  r++

  rows.push([`日期: ${nowStr}`, null, null, '日期:', null, null, '日期:', null, '（盖章）'])
  merges.push({ s: { r, c: 0 }, e: { r, c: 2 } })
  merges.push({ s: { r, c: 3 }, e: { r, c: 5 } })
  merges.push({ s: { r, c: 6 }, e: { r, c: 7 } })

  // ── 构建 worksheet ───────────────────────────────────────
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = merges

  // 列宽
  ws['!cols'] = [
    { wch: 6 },   // A: 收/支
    { wch: 10 },  // B: 时间/图片
    { wch: 18 },  // C: 款号/摘要
    { wch: 6 },   // D: (merged with C)
    { wch: 14 },  // E: 供应商
    { wch: 8 },   // F: 单位
    { wch: 10 },  // G: 数量
    { wch: 12 },  // H: 单价
    { wch: 14 },  // I: 金额/备注
  ]

  // 行高：标题行更高
  ws['!rows'] = [
    { hpt: 28 },  // 公司名CN
    { hpt: 20 },  // 公司名EN
    { hpt: 26 },  // 报表标题
    { hpt: 20 },  // 信息块
  ]

  // ── 导出 ─────────────────────────────────────────────────
  const wb = XLSX.utils.book_new()
  const sheetName = type === 'budget' ? '订单预算表' : '订单决算单'
  XLSX.utils.book_append_sheet(wb, ws, sheetName)

  const safeOrderNo = order.order_no.replace(/[\\/:*?"<>|]/g, '_')
  const dateStr = nowStr.replace(/\//g, '-')
  const prefix = type === 'budget' ? '预算表' : '决算单'
  XLSX.writeFile(wb, `${prefix}_${safeOrderNo}_${dateStr}.xlsx`)
}
