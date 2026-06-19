// ============================================================
// 订单列表完整导出（含节拍器原始数据 + 决算实际数据）
// 财务总能在一张 Excel 里看到：预算 / 节拍器 / 决算 三方信息
// ============================================================

import * as XLSX from 'xlsx'
import { companyInfo } from './company-config'
import type { BudgetOrder } from '@/lib/types'

export interface SyncedOrderInfo {
  qmNo: string         // 节拍器订单号
  internalNo: string   // 节拍器内部款号
  lifecycle?: string   // 节拍器订单生命周期
  customer?: string    // 节拍器客户名（核对用）
  qty?: number         // 节拍器数量
  unit?: string        // 数量单位
}

export interface SettlementInfo {
  final_profit: number       // 实际利润
  final_margin: number       // 实际毛利率
  status: string             // draft / confirmed / locked
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  pending_review: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  closed: '已关闭',
}

const SETTLEMENT_LABELS: Record<string, string> = {
  draft: '决算草稿',
  confirmed: '决算已确认',
  locked: '决算已锁定',
}

/**
 * 完整订单导出：每行含 预算 + 节拍器 + 决算 全维度。
 * 财务一份 Excel 看清所有订单的全貌。
 */
export function exportOrdersComprehensiveToExcel(
  orders: BudgetOrder[],
  syncedMap: Record<string, SyncedOrderInfo>,
  settlementMap: Record<string, SettlementInfo>,
  filename?: string
): void {
  const now = new Date().toLocaleDateString('zh-CN')

  // 表头（双层）：分组标识 + 字段名
  // XLSX 不强制双层表头，我们用一行表头 + 字段名前缀分组
  const data = orders.map((o, index) => {
    const synced = syncedMap[o.id] || {}
    const sett = settlementMap[o.id]
    const isSettled = sett && (sett.status === 'confirmed' || sett.status === 'locked')

    return {
      '#':                 index + 1,
      // ── 财务侧（预算单）── //
      '财务订单号':         o.order_no || '',
      '客户':               o.customer?.company || '',
      '国家':               o.customer?.country || '',
      '下单日期':           o.order_date,
      '交货日期':           o.delivery_date || '',
      '币种':               o.currency,
      '汇率':               o.exchange_rate,
      '合同金额':           o.total_revenue,
      '预算总成本(¥)':      o.total_cost,
      '预估利润(¥)':        o.estimated_profit,
      '预估毛利率(%)':      o.estimated_margin,
      '财务状态':           STATUS_LABELS[o.status] || o.status,
      // ── 节拍器侧（来自 synced_orders）── //
      '节拍器订单号':       synced.qmNo || '',
      '内部款号':           synced.internalNo || '',
      '生产数量':           synced.qty ?? '',
      '数量单位':           synced.unit || '',
      '节拍器状态':         synced.lifecycle || '',
      // ── 决算侧（来自 order_settlements）── //
      '实际利润(¥)':        isSettled ? sett.final_profit : '',
      '实际毛利率(%)':      isSettled ? sett.final_margin : '',
      '利润差异(¥)':        isSettled ? Math.round((sett.final_profit - o.estimated_profit) * 100) / 100 : '',
      '毛利率差异(pp)':     isSettled ? Math.round((sett.final_margin - o.estimated_margin) * 100) / 100 : '',
      '决算状态':           sett ? (SETTLEMENT_LABELS[sett.status] || sett.status) : '未生成',
      '备注':               o.notes || '',
    }
  })

  // 计算合计行（仅汇总数值列）；合同金额折人民币再加（原币不能跨币种裸加）
  const totalRevenue = orders.reduce((s, o) => s + (o.total_revenue || 0) * (o.currency === 'CNY' ? 1 : (Number(o.exchange_rate) || 1)), 0)
  const totalCost = orders.reduce((s, o) => s + o.total_cost, 0)
  const totalEstProfit = orders.reduce((s, o) => s + o.estimated_profit, 0)
  const totalActualProfit = orders.reduce((s, o) => {
    const sett = settlementMap[o.id]
    return s + (sett && (sett.status === 'confirmed' || sett.status === 'locked') ? sett.final_profit : 0)
  }, 0)

  // 用 aoa 模式构建（方便加抬头 + 合计行 + 签字栏）
  const headers = Object.keys(data[0] ?? {
    '#': '', '财务订单号': '', '客户': '', '国家': '', '下单日期': '', '交货日期': '',
    '币种': '', '汇率': '', '合同金额': '', '预算总成本(¥)': '', '预估利润(¥)': '', '预估毛利率(%)': '',
    '财务状态': '', '节拍器订单号': '', '内部款号': '', '生产数量': '', '数量单位': '', '节拍器状态': '',
    '实际利润(¥)': '', '实际毛利率(%)': '', '利润差异(¥)': '', '毛利率差异(pp)': '', '决算状态': '', '备注': '',
  })
  const colCount = headers.length

  const rows: (string | number)[][] = []

  // 抬头
  rows.push([companyInfo.full_name, ...Array(colCount - 1).fill('')])
  rows.push(['订单全维度对账表（含节拍器 + 决算）', ...Array(colCount - 1).fill('')])
  rows.push([
    `生成日期: ${now}`,
    '',
    `订单总数: ${orders.length}`,
    '',
    `已生成决算: ${orders.filter(o => settlementMap[o.id]).length}`,
    '',
    `已确认决算: ${orders.filter(o => {
      const s = settlementMap[o.id]
      return s && (s.status === 'confirmed' || s.status === 'locked')
    }).length}`,
    ...Array(colCount - 7).fill(''),
  ])
  rows.push(Array(colCount).fill(''))

  // 列头
  rows.push(headers)

  // 数据行
  data.forEach(row => {
    rows.push(headers.map(h => (row as Record<string, string | number>)[h] ?? ''))
  })

  // 合计行
  if (orders.length > 0) {
    const totalsRow: (string | number)[] = Array(colCount).fill('')
    totalsRow[0] = ''
    totalsRow[1] = '合计'
    const idxRevenue = headers.indexOf('合同金额')
    const idxCost    = headers.indexOf('预算总成本(¥)')
    const idxEstP    = headers.indexOf('预估利润(¥)')
    const idxActP    = headers.indexOf('实际利润(¥)')
    const idxCur = headers.indexOf('币种')
    if (idxCur >= 0) totalsRow[idxCur] = '¥折算'  // 合计为折人民币口径（各单原币不可直加）
    if (idxRevenue >= 0) totalsRow[idxRevenue] = Math.round(totalRevenue * 100) / 100
    if (idxCost >= 0)    totalsRow[idxCost] = Math.round(totalCost * 100) / 100
    if (idxEstP >= 0)    totalsRow[idxEstP] = Math.round(totalEstProfit * 100) / 100
    if (idxActP >= 0)    totalsRow[idxActP] = Math.round(totalActualProfit * 100) / 100
    rows.push(totalsRow)
  }

  rows.push(Array(colCount).fill(''))
  rows.push(Array(colCount).fill(''))

  // 签字栏
  const sigRow: string[] = Array(colCount).fill('')
  sigRow[0] = `${companyInfo.preparer.title}: ${companyInfo.preparer.name}`
  sigRow[Math.floor(colCount / 3)] = `${companyInfo.reviewer.title}: ${companyInfo.reviewer.name}`
  sigRow[Math.floor((colCount * 2) / 3)] = `${companyInfo.approver.title}: ${companyInfo.approver.name || '________'}`
  rows.push(sigRow)
  const dateRow: string[] = Array(colCount).fill('')
  dateRow[0] = `日期: ${now}`
  dateRow[Math.floor(colCount / 3)] = '日期:'
  dateRow[Math.floor((colCount * 2) / 3)] = '日期:'
  dateRow[colCount - 1] = '（盖章处）'
  rows.push(dateRow)

  // 构建 worksheet
  const ws = XLSX.utils.aoa_to_sheet(rows)

  // 合并：抬头与标题
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: colCount - 1 } },
  ]

  // 列宽
  ws['!cols'] = headers.map(h => {
    if (h === '#') return { wch: 4 }
    if (h === '客户' || h === '备注') return { wch: 22 }
    if (h.includes('日期') || h.includes('状态')) return { wch: 12 }
    if (h.includes('号') || h.includes('款号')) return { wch: 18 }
    return { wch: 14 }
  })

  // 输出
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '订单全维度')
  const dateStr = now.replace(/\//g, '-')
  XLSX.writeFile(wb, filename || `订单全维度_${orders.length}单_${dateStr}.xlsx`)
}
