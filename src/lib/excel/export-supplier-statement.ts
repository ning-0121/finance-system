// ============================================================
// 供应商对账单（流水台账格式）
// 每个供应商一段流水，按日期排列：
//   费用(+) 为正数行，付款(−) 为负数行，逐行滚动「累计余额」。
//   期末累计余额 = 该供应商「实际未付金额」，可直接与供应商核对，
//   无需人工再扣减已付货款。
//
// 列：序号 | 日期 | 内部订单号 | 摘要 | 单位 | 数量 | 单价 | 费用(+) | 付款(−) | 累计余额
//   - 费用：来自 cost_items（含 单位/数量/单价），挂内部订单号
//   - 付款：来自 supplier_payments，只挂供应商、不挂订单号
// ============================================================

import * as XLSX from 'xlsx'
import { toChineseUppercase } from './chinese-amount'
import { companyInfo } from './company-config'

export interface StatementCharge {
  supplier: string
  date: string            // 费用日期（cost_items.created_at）
  internal_no: string     // 内部订单号
  description: string     // 摘要/品名
  unit: string            // 单位（米/公斤/件…）
  qty: number | null      // 数量
  unit_price: number | null // 单价
  amount: number          // 费用金额（正数）
}

export interface StatementPayment {
  supplier: string
  date: string            // 付款日期（supplier_payments.paid_at）
  amount: number          // 付款金额（正数存储，台账内展示为负数）
  note: string            // 备注
}

type LedgerEntry = {
  date: string
  kind: 'charge' | 'payment'
  internal_no: string
  description: string
  unit: string
  qty: number | null
  unit_price: number | null
  charge: number   // 费用(+)；付款行为 0
  payment: number  // 付款(−)，正数；费用行为 0
}

function dateKey(s: string): string {
  if (!s) return ''
  return s.length >= 10 ? s.substring(0, 10) : s
}

export function exportSupplierStatementToExcel(
  charges: StatementCharge[],
  payments: StatementPayment[],
  dateRange: { start: string; end: string }
): void {
  const now = new Date().toLocaleDateString('zh-CN')
  const periodLabel = dateRange.start && dateRange.end
    ? `${dateRange.start} 至 ${dateRange.end}`
    : '全部时间'

  // 按供应商聚合
  const suppliers = new Map<string, LedgerEntry[]>()
  for (const c of charges) {
    const list = suppliers.get(c.supplier) || []
    list.push({
      date: dateKey(c.date), kind: 'charge',
      internal_no: c.internal_no || '', description: c.description || '',
      unit: c.unit || '', qty: c.qty, unit_price: c.unit_price,
      charge: c.amount || 0, payment: 0,
    })
    suppliers.set(c.supplier, list)
  }
  for (const p of payments) {
    const list = suppliers.get(p.supplier) || []
    list.push({
      date: dateKey(p.date), kind: 'payment',
      internal_no: '', description: p.note ? `付款 ${p.note}` : '付款',
      unit: '', qty: null, unit_price: null,
      charge: 0, payment: p.amount || 0,
    })
    suppliers.set(p.supplier, list)
  }

  // 每个供应商内按日期升序（无日期排最前），付款排在同日费用之后
  for (const list of suppliers.values()) {
    list.sort((a, b) => {
      if (a.date !== b.date) return (a.date || '0').localeCompare(b.date || '0')
      if (a.kind !== b.kind) return a.kind === 'charge' ? -1 : 1
      return 0
    })
  }

  // 供应商按期末余额（未付）降序
  const ordered = Array.from(suppliers.entries())
    .map(([s, list]) => {
      const totalCharge = list.reduce((x, e) => x + e.charge, 0)
      const totalPayment = list.reduce((x, e) => x + e.payment, 0)
      return { supplier: s, list, totalCharge, totalPayment, balance: totalCharge - totalPayment }
    })
    .sort((a, b) => b.balance - a.balance)

  const COLS = 10
  const rows: (string | number)[][] = []
  const merges: XLSX.Range[] = []

  // 抬头
  rows.push([companyInfo.full_name, '', '', '', '', '', '', '', '', '']); merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: COLS - 1 } })
  rows.push(['供应商对账单（流水台账 · 余额即实际未付）', '', '', '', '', '', '', '', '', '']); merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: COLS - 1 } })
  rows.push([`期间: ${periodLabel}`, '', '', `供应商数: ${ordered.length}`, '', '', '', `生成日期: ${now}`, '', ''])
  rows.push(Array(COLS).fill(''))

  // 列头
  rows.push(['序号', '日期', '内部订单号', '摘要', '单位', '数量', '单价', '费用(+)', '付款(−)', '累计余额'])

  let grandUnpaid = 0

  for (const { supplier, list, totalCharge, totalPayment, balance } of ordered) {
    // 供应商分组标题行
    const titleRow = rows.length
    rows.push([`供应商：${supplier}`, '', '', '', '', '', '', '', '', ''])
    merges.push({ s: { r: titleRow, c: 0 }, e: { r: titleRow, c: COLS - 1 } })

    let running = 0
    let seq = 1
    for (const e of list) {
      running += e.charge - e.payment
      rows.push([
        seq++,
        e.date || '—',
        e.internal_no || '—',
        e.description || '',
        e.unit || '',
        e.qty != null ? e.qty : '',
        e.unit_price != null ? e.unit_price : '',
        e.charge ? Math.round(e.charge * 100) / 100 : '',
        e.payment ? -Math.round(e.payment * 100) / 100 : '',
        Math.round(running * 100) / 100,
      ])
    }
    // 供应商小计
    rows.push([
      '', '', '', '小计', '', '', '',
      Math.round(totalCharge * 100) / 100,
      totalPayment ? -Math.round(totalPayment * 100) / 100 : 0,
      Math.round(balance * 100) / 100,
    ])
    grandUnpaid += balance
  }

  // 总计
  rows.push(Array(COLS).fill(''))
  rows.push(['', '', '', '应付合计（实际未付）', '', '', '', '', '', Math.round(grandUnpaid * 100) / 100])
  rows.push([`未付金额大写: ${toChineseUppercase(grandUnpaid)}`, '', '', '', '', '', '', '', '', ''])
  rows.push(Array(COLS).fill(''))
  rows.push(Array(COLS).fill(''))

  // 签字栏
  rows.push([
    `${companyInfo.preparer.title}: ${companyInfo.preparer.name}`, '', '',
    `${companyInfo.reviewer.title}: ${companyInfo.reviewer.name}`, '', '',
    `${companyInfo.approver.title}: ${companyInfo.approver.name || '________'}`, '', '', '',
  ])
  rows.push([`日期: ${now}`, '', '', '日期:', '', '', '日期:', '', '', '（盖章处）'])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = merges
  ws['!cols'] = [
    { wch: 5 },   // 序号
    { wch: 12 },  // 日期
    { wch: 16 },  // 内部订单号
    { wch: 26 },  // 摘要
    { wch: 6 },   // 单位
    { wch: 9 },   // 数量
    { wch: 9 },   // 单价
    { wch: 13 },  // 费用(+)
    { wch: 13 },  // 付款(−)
    { wch: 14 },  // 累计余额
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '供应商对账单')
  const safePeriod = periodLabel.replace(/[\\/:*?"<>|\s]/g, '_')
  XLSX.writeFile(wb, `供应商对账单_${safePeriod}.xlsx`)
}
