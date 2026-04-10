// ============================================================
// 专业财务报表导出引擎
// 公司抬头 + 签字栏 + 大写金额 + 合计行
// ============================================================

import * as XLSX from 'xlsx'
import { toChineseUppercase } from './chinese-amount'
import { companyInfo } from './company-config'
import type { BudgetOrder } from '@/lib/types'

// --- 费用汇总表 ---
export function exportCostSummaryReport(
  data: { category: string; count: number; amount: number; currency: string }[],
  dateRange: { start: string; end: string }
) {
  const totalAmount = data.reduce((s, d) => s + d.amount, 0)
  const now = new Date().toLocaleDateString('zh-CN')

  const rows: (string | number)[][] = [
    [companyInfo.full_name],
    ['费用汇总表'],
    [`报表期间: ${dateRange.start} 至 ${dateRange.end}`, '', '', `生成日期: ${now}`],
    [],
    ['序号', '费用类别', '笔数', '金额', '币种', '占比(%)'],
  ]

  data.forEach((d, i) => {
    rows.push([
      i + 1,
      d.category,
      d.count,
      d.amount,
      d.currency,
      totalAmount > 0 ? Math.round((d.amount / totalAmount) * 10000) / 100 : 0,
    ])
  })

  rows.push(['', '合计', data.reduce((s, d) => s + d.count, 0), totalAmount, '', '100.00'])
  rows.push([`金额大写: ${toChineseUppercase(totalAmount)}`])
  rows.push([])
  rows.push([])

  // 签字栏
  rows.push([
    `${companyInfo.preparer.title}: ${companyInfo.preparer.name}`,
    '',
    `${companyInfo.reviewer.title}: ${companyInfo.reviewer.name}`,
    '',
    `${companyInfo.approver.title}: ${companyInfo.approver.name || '________'}`,
    '',
  ])
  rows.push([
    `日期: ${now}`,
    '',
    `日期:`,
    '',
    `日期:`,
    '',
  ])
  rows.push([])
  rows.push(['', '', '', '', '', '（盖章处）'])

  const ws = XLSX.utils.aoa_to_sheet(rows)

  // 合并单元格
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }, // 公司名
    { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } }, // 报表标题
    { s: { r: rows.length - 7, c: 0 }, e: { r: rows.length - 7, c: 5 } }, // 大写金额
  ]

  // 列宽
  ws['!cols'] = [
    { wch: 6 }, { wch: 15 }, { wch: 8 }, { wch: 18 }, { wch: 8 }, { wch: 10 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '费用汇总表')
  XLSX.writeFile(wb, `费用汇总表_${dateRange.start}_${dateRange.end}.xlsx`)
}

// --- 预算结算对比表 ---
export function exportBudgetSettlementReport(orders: {
  order_no: string
  customer: string
  budget_revenue: number
  actual_revenue: number
  budget_cost: number
  actual_cost: number
  budget_profit: number
  actual_profit: number
  variance: number
  variance_pct: number
  currency: string
}[]) {
  const now = new Date().toLocaleDateString('zh-CN')
  const totalBudgetProfit = orders.reduce((s, o) => s + o.budget_profit, 0)
  const totalActualProfit = orders.reduce((s, o) => s + o.actual_profit, 0)
  const totalVariance = orders.reduce((s, o) => s + o.variance, 0)

  const rows: (string | number)[][] = [
    [companyInfo.full_name],
    ['预算结算对比表'],
    [`生成日期: ${now}`],
    [],
    ['序号', '订单号', '客户', '币种', '预算收入', '实际收入', '预算成本', '实际成本', '预算利润', '实际利润', '差异', '差异率(%)'],
  ]

  orders.forEach((o, i) => {
    rows.push([
      i + 1, o.order_no, o.customer, o.currency,
      o.budget_revenue, o.actual_revenue,
      o.budget_cost, o.actual_cost,
      o.budget_profit, o.actual_profit,
      o.variance, o.variance_pct,
    ])
  })

  rows.push([
    '', '合计', '', '',
    orders.reduce((s, o) => s + o.budget_revenue, 0),
    orders.reduce((s, o) => s + o.actual_revenue, 0),
    orders.reduce((s, o) => s + o.budget_cost, 0),
    orders.reduce((s, o) => s + o.actual_cost, 0),
    totalBudgetProfit, totalActualProfit, totalVariance, '',
  ])
  rows.push([`利润差异大写: ${toChineseUppercase(Math.abs(totalVariance))}${totalVariance >= 0 ? '（盈余）' : '（亏损）'}`])
  rows.push([])
  rows.push([])
  rows.push([
    `${companyInfo.preparer.title}: ${companyInfo.preparer.name}`, '', '',
    `${companyInfo.reviewer.title}: ${companyInfo.reviewer.name}`, '', '',
    `${companyInfo.approver.title}: ${companyInfo.approver.name || '________'}`, '', '', '', '', '',
  ])
  rows.push([`日期: ${now}`, '', '', '日期:', '', '', '日期:', '', '', '', '', '（盖章处）'])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 11 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 11 } },
  ]
  ws['!cols'] = [
    { wch: 5 }, { wch: 18 }, { wch: 20 }, { wch: 6 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '预算结算对比表')
  XLSX.writeFile(wb, `预算结算对比表_${now.replace(/\//g, '-')}.xlsx`)
}

// --- 利润分析表 ---
export function exportProfitAnalysisReport(orders: BudgetOrder[]) {
  const now = new Date().toLocaleDateString('zh-CN')
  const totalRevenue = orders.reduce((s, o) => s + o.total_revenue, 0)
  const totalCost = orders.reduce((s, o) => s + o.total_cost, 0)
  const totalProfit = orders.reduce((s, o) => s + o.estimated_profit, 0)
  const avgMargin = orders.length > 0
    ? orders.reduce((s, o) => s + o.estimated_margin, 0) / orders.length
    : 0

  const rows: (string | number)[][] = [
    [companyInfo.full_name],
    ['利润分析表'],
    [`生成日期: ${now}`, '', '', '', '', '', `订单数: ${orders.length}`],
    [],
    ['序号', '订单号', '客户', '币种', '总收入', '总成本', '利润', '毛利率(%)', '状态'],
  ]

  orders.forEach((o, i) => {
    rows.push([
      i + 1,
      o.order_no,
      o.customer?.company || '',
      o.currency,
      o.total_revenue,
      o.total_cost,
      o.estimated_profit,
      o.estimated_margin,
      o.status === 'approved' ? '已通过' : o.status === 'closed' ? '已关闭' : o.status === 'pending_review' ? '待审批' : o.status === 'draft' ? '草稿' : o.status,
    ])
  })

  rows.push(['', '合计', '', '', totalRevenue, totalCost, totalProfit, Math.round(avgMargin * 100) / 100, ''])
  rows.push([`利润合计大写: ${toChineseUppercase(totalProfit)}`])
  rows.push([])
  rows.push([])
  rows.push([
    `${companyInfo.preparer.title}: ${companyInfo.preparer.name}`, '', '',
    `${companyInfo.reviewer.title}: ${companyInfo.reviewer.name}`, '', '',
    `${companyInfo.approver.title}: ${companyInfo.approver.name || '________'}`, '', '',
  ])
  rows.push([`日期: ${now}`, '', '', '日期:', '', '', '日期:', '', '（盖章处）'])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } },
  ]
  ws['!cols'] = [
    { wch: 5 }, { wch: 18 }, { wch: 22 }, { wch: 6 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 8 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '利润分析表')
  XLSX.writeFile(wb, `利润分析表_${now.replace(/\//g, '-')}.xlsx`)
}
