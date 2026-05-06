// ============================================================
// 单个订单决算单导出（对账单）
// 财务格式：公司抬头 + 订单基本信息 + 子单据预算 vs 实际 +
//          库存冲减 + 汇总 + 大写金额 + 签字栏
// ============================================================

import * as XLSX from 'xlsx'
import { toChineseUppercase } from './chinese-amount'
import { companyInfo } from './company-config'
import type { BudgetOrder, OrderSettlement, InventoryReturn } from '@/lib/types'

const docTypeLabels: Record<string, string> = {
  raw_material: '原料采购',
  fabric: '面料采购',
  accessory: '辅料采购',
  processing: '加工费',
  freight: '运费',
  customs: '报关',
  forwarder: '货代',
  other: '其它',
}

const returnTypeLabels: Record<string, string> = {
  raw_material: '原料',
  auxiliary: '辅料',
  finished_good: '成品',
  defective: '次品',
}

const treatmentLabels: Record<string, string> = {
  add_to_cost: '计入成本',
  reduce_cost: '冲减成本',
  scrap: '报废',
}

/**
 * 导出单笔订单决算单 Excel。
 * 文件名：决算单_<order_no>_<生成日期>.xlsx
 */
export function exportSettlementSheetToExcel(
  order: BudgetOrder,
  settlement: OrderSettlement,
  returns: InventoryReturn[] = []
): void {
  const now = new Date()
  const nowStr = now.toLocaleDateString('zh-CN')
  const customer = order.customer?.company || '-'
  const currency = order.currency || 'CNY'
  const currencySymbol = currency === 'CNY' ? '¥' : '$'

  // 状态文本
  const statusText: Record<string, string> = {
    draft: '草稿',
    confirmed: '已确认',
    locked: '已锁定',
  }

  const rows: (string | number)[][] = []

  // ── 报表头 ─────────────────────────────────────────────────────────────
  rows.push([companyInfo.full_name])
  rows.push(['订 单 决 算 单'])
  rows.push([`生成日期: ${nowStr}`, '', '', '', '', `决算状态: ${statusText[settlement.status] || settlement.status}`])
  rows.push([])

  // ── 订单基本信息（2 列对照） ───────────────────────────────────────────
  rows.push(['── 订单基本信息 ──'])
  rows.push(['订单号', order.order_no, '', '客户', customer, ''])
  rows.push(['下单日期', order.order_date || '-', '', '币种', currency, ''])
  rows.push(['交期', order.delivery_date || '-', '', '汇率', String(order.exchange_rate ?? 1), ''])
  rows.push(['合同金额', `${currencySymbol} ${order.total_revenue.toLocaleString()}`, '', '预估利润', `¥ ${order.estimated_profit.toLocaleString()}`, `(${order.estimated_margin}%)`])
  rows.push([])

  // ── 子单据决算明细 ─────────────────────────────────────────────────────
  rows.push(['── 子单据决算明细 ──'])
  rows.push(['序号', '类型', '供应商', '预算金额(¥)', '实际金额(¥)', '差异(¥)', '差异率(%)'])

  let totalSubBudget = 0
  let totalSubActual = 0
  if (settlement.sub_settlements && settlement.sub_settlements.length > 0) {
    settlement.sub_settlements.forEach((s, i) => {
      const variance = s.variance || (s.actual - s.budgeted)
      const variancePct = s.variance_pct || (s.budgeted > 0 ? (variance / s.budgeted) * 100 : 0)
      totalSubBudget += s.budgeted
      totalSubActual += s.actual
      rows.push([
        i + 1,
        docTypeLabels[s.doc_type] || s.doc_type,
        s.supplier_name || '-',
        s.budgeted,
        s.actual,
        variance,
        Math.round(variancePct * 100) / 100,
      ])
    })
    // 子单据合计行
    rows.push([
      '',
      '小计',
      '',
      totalSubBudget,
      totalSubActual,
      totalSubActual - totalSubBudget,
      totalSubBudget > 0 ? Math.round(((totalSubActual - totalSubBudget) / totalSubBudget) * 10000) / 100 : 0,
    ])
  } else {
    rows.push(['', '（无子单据决算明细）', '', '', '', '', ''])
  }
  rows.push([])

  // ── 订单级费用（运费/佣金/税费/其他） ────────────────────────────────
  if (settlement.order_level_costs && settlement.order_level_costs.length > 0) {
    rows.push(['── 订单级费用 ──'])
    rows.push(['序号', '费用类别', '', '预算金额(¥)', '实际金额(¥)', '差异(¥)', ''])
    settlement.order_level_costs.forEach((c, i) => {
      rows.push([
        i + 1,
        c.category,
        '',
        c.budgeted,
        c.actual,
        c.variance,
        '',
      ])
    })
    rows.push([])
  }

  // ── 库存冲减 ─────────────────────────────────────────────────────────
  if (returns && returns.length > 0) {
    rows.push(['── 剩余物料/入库冲减 ──'])
    rows.push(['序号', '类型', '描述', '金额(¥)', '会计处理', '', ''])
    returns.forEach((r, i) => {
      rows.push([
        i + 1,
        returnTypeLabels[r.return_type] || r.return_type,
        r.items?.[0]?.name || '-',
        r.total_value,
        treatmentLabels[r.accounting_treatment] || r.accounting_treatment,
        '',
        '',
      ])
    })
    if (settlement.inventory_credit > 0) {
      rows.push(['', '冲减成本合计', '', -settlement.inventory_credit, '', '', ''])
    }
    rows.push([])
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────
  rows.push(['── 决算汇总 ──'])
  rows.push(['项目', '金额', '', '', '', '', ''])
  rows.push(['预算总成本(¥)', settlement.total_budget, '', '', '', '', ''])
  rows.push(['实际总成本(¥)', settlement.total_actual, '', '', '', '', ''])
  rows.push(['总差异(¥)', settlement.total_variance, settlement.total_variance > 0 ? '(超支)' : settlement.total_variance < 0 ? '(节省)' : '', '', '', '', ''])
  if (settlement.inventory_credit > 0) {
    rows.push(['库存冲减(¥)', -settlement.inventory_credit, '', '', '', '', ''])
  }
  rows.push([`合同金额(${currency})`, order.total_revenue, '', '', '', '', ''])
  rows.push(['最终利润(¥)', settlement.final_profit, settlement.final_profit < 0 ? '(亏损)' : '(盈利)', '', '', '', ''])
  rows.push(['最终毛利率(%)', settlement.final_margin, '', '', '', '', ''])
  rows.push([])

  // ── 大写金额 ─────────────────────────────────────────────────────────
  rows.push([`最终利润大写: ${toChineseUppercase(Math.abs(settlement.final_profit))}${settlement.final_profit < 0 ? '（亏损）' : ''}`])
  rows.push([])
  rows.push([])

  // ── 签字栏 ───────────────────────────────────────────────────────────
  rows.push([
    `${companyInfo.preparer.title}: ${companyInfo.preparer.name}`,
    '',
    `${companyInfo.reviewer.title}: ${companyInfo.reviewer.name}`,
    '',
    `${companyInfo.approver.title}: ${companyInfo.approver.name || '________'}`,
    '',
    '',
  ])
  rows.push([
    `日期: ${nowStr}`,
    '',
    '日期:',
    '',
    '日期:',
    '',
    '（盖章处）',
  ])

  // ── 构建 worksheet ───────────────────────────────────────────────────
  const ws = XLSX.utils.aoa_to_sheet(rows)

  // 合并单元格：标题行
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }, // 公司名
    { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }, // 报表标题
  ]

  // 列宽
  ws['!cols'] = [
    { wch: 8 },   // 序号 / 项目
    { wch: 22 },  // 类型 / 金额
    { wch: 18 },  // 供应商
    { wch: 14 },  // 预算
    { wch: 14 },  // 实际
    { wch: 14 },  // 差异
    { wch: 12 },  // 差异率
  ]

  // 文件名
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '订单决算单')
  const safeOrderNo = order.order_no.replace(/[\\/:*?"<>|]/g, '_')
  const dateStr = nowStr.replace(/\//g, '-')
  XLSX.writeFile(wb, `决算单_${safeOrderNo}_${dateStr}.xlsx`)
}
