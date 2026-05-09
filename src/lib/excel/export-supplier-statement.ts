// ============================================================
// 供应商对账单（详单格式）
// 财务核对依赖**内部订单号**为主键，因此每行包含：
//   供应商 | 内部订单号 | 节拍器订单号 | 财务订单号 | 费用类型 |
//   描述 | 金额 | 币种 | 付款状态 | 日期
// 含按供应商分组小计 + 总合计 + 大写金额 + 签字栏
// ============================================================

import * as XLSX from 'xlsx'
import { toChineseUppercase } from './chinese-amount'
import { companyInfo } from './company-config'

export interface SupplierStatementLine {
  supplier: string
  description: string
  amount: number
  currency: string
  cost_type: string
  order_no: string          // 财务订单号 (BO-202604-0036)
  internal_no: string       // 内部订单号 (= synced_orders.style_no) — 财务核对主键
  metronome_no: string      // 节拍器订单号
  created_at: string
  is_paid: boolean
}

export function exportSupplierStatementToExcel(
  details: SupplierStatementLine[],
  dateRange: { start: string; end: string }
): void {
  const now = new Date().toLocaleDateString('zh-CN')
  const periodLabel = dateRange.start && dateRange.end
    ? `${dateRange.start} 至 ${dateRange.end}`
    : '全部时间'

  // 按供应商分组，每组按内部订单号排序（财务核对主序）
  const grouped = new Map<string, SupplierStatementLine[]>()
  for (const d of details) {
    const list = grouped.get(d.supplier) || []
    list.push(d)
    grouped.set(d.supplier, list)
  }
  // 每组内按 内部订单号 → 日期 排序
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      const aKey = (a.internal_no || 'zzz') + a.created_at
      const bKey = (b.internal_no || 'zzz') + b.created_at
      return aKey.localeCompare(bKey)
    })
  }

  // 供应商按总额降序
  const orderedSuppliers = Array.from(grouped.entries())
    .map(([s, list]) => ({ s, list, total: list.reduce((x, y) => x + y.amount, 0) }))
    .sort((a, b) => b.total - a.total)

  const COLS = 11   // 序号 + 10 个字段
  const rows: (string | number)[][] = []

  // 抬头
  rows.push([companyInfo.full_name, '', '', '', '', '', '', '', '', '', ''])
  rows.push(['供应商对账单（按内部订单号）', '', '', '', '', '', '', '', '', '', ''])
  rows.push([
    `期间: ${periodLabel}`, '', '',
    `供应商总数: ${orderedSuppliers.length}`, '', '',
    `明细笔数: ${details.length}`, '', '',
    `生成日期: ${now}`, '',
  ])
  rows.push(Array(COLS).fill(''))

  // 列头
  rows.push([
    '序号', '供应商', '内部订单号', '节拍器订单号', '财务订单号',
    '费用类型', '描述', '金额', '币种', '付款状态', '日期',
  ])

  let rowIndex = 1
  let grandTotal = 0

  for (const { s, list, total } of orderedSuppliers) {
    // 该供应商所有明细
    for (const d of list) {
      rows.push([
        rowIndex++,
        d.supplier,
        d.internal_no || '—',           // 内部订单号 — 主键
        d.metronome_no || '—',
        d.order_no || '—',
        d.cost_type || '',
        d.description || '',
        Math.round(d.amount * 100) / 100,
        d.currency || 'CNY',
        d.is_paid ? '已付' : '未付',
        new Date(d.created_at).toLocaleDateString('zh-CN'),
      ])
    }
    // 供应商小计行
    rows.push([
      '', s, '', '', '', '小计', `${list.length} 笔`,
      Math.round(total * 100) / 100, '', '', '',
    ])
    grandTotal += total
  }

  // 总合计
  rows.push(Array(COLS).fill(''))
  rows.push([
    '', '总合计', '', '', '', '', `${details.length} 笔`,
    Math.round(grandTotal * 100) / 100, '', '', '',
  ])
  rows.push([
    `金额大写: ${toChineseUppercase(grandTotal)}`,
    '', '', '', '', '', '', '', '', '', '',
  ])
  rows.push(Array(COLS).fill(''))
  rows.push(Array(COLS).fill(''))

  // 签字栏
  rows.push([
    `${companyInfo.preparer.title}: ${companyInfo.preparer.name}`,
    '', '', '',
    `${companyInfo.reviewer.title}: ${companyInfo.reviewer.name}`,
    '', '', '',
    `${companyInfo.approver.title}: ${companyInfo.approver.name || '________'}`,
    '', '',
  ])
  rows.push([
    `日期: ${now}`,
    '', '', '',
    '日期:',
    '', '', '',
    '日期:',
    '', '（盖章处）',
  ])

  const ws = XLSX.utils.aoa_to_sheet(rows)

  // 合并：抬头与标题
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: COLS - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: COLS - 1 } },
  ]

  // 列宽
  ws['!cols'] = [
    { wch: 5 },   // 序号
    { wch: 18 },  // 供应商
    { wch: 16 },  // 内部订单号 (重点)
    { wch: 16 },  // 节拍器订单号
    { wch: 18 },  // 财务订单号
    { wch: 12 },  // 费用类型
    { wch: 28 },  // 描述
    { wch: 14 },  // 金额
    { wch: 6 },   // 币种
    { wch: 8 },   // 付款状态
    { wch: 12 },  // 日期
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '供应商对账单')

  const safePeriod = periodLabel.replace(/[\\/:*?"<>|\s]/g, '_')
  XLSX.writeFile(wb, `供应商对账单_${safePeriod}.xlsx`)
}
