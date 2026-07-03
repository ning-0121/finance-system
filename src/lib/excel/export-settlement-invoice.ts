/**
 * 订单核算单（决算单）按义乌绮陌服饰格式导出 — 严格按图片复刻
 *
 * 9 列布局：
 *   A: 收/支 标签（垂直合并）
 *   B: 时间
 *   C: 摘要        ← 收: 在 C-E 合并；支: 单列
 *   D: 收=合并 | 支=供应商
 *   E: 收=合并 | 支=单位
 *   F: 收=美金   | 支=数量
 *   G: 收=汇率   | 支=单价
 *   H: 金额（两区相同含义：CNY）
 *   I: 备注
 *
 * 数据流：
 *   • 收: actual_invoices WHERE invoice_type='customer_statement' AND status='paid'
 *        （每条一行；FX 来自 invoice.exchange_rate，缺省回退 order.exchange_rate）
 *   • 支: cost_items WHERE deleted_at IS NULL（按 supplier × cost_group 聚合）
 *        若 cost_items 为空 → 从 budget_orders.items[0]._cost_breakdown 合成（标注"预算估算"）
 *
 * 备注：缺失数据全部 hard-fail-then-fallback-with-warning，不静默隐藏
 */
import * as XLSX from 'xlsx'
import Decimal from 'decimal.js'
import type { BudgetOrder } from '@/lib/types'

// ──────────────────────────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────────────────────────

export interface ReceiptRow {
  date: string         // 'YYYY-MM-DD' 或 显示用 'YYYY年MM月DD日'
  description: string  // 默认 '美金货款'
  usd: number
  rate: number
  cny: number
  note: string         // 客户/付款方
}

export interface ExpenseRow {
  date: string
  description: string  // 摘要（包装袋/PL479主吊牌/...）
  supplier: string     // 供应商
  unit: string         // 单位（只/件/kg/...）
  quantity: number | null
  unit_price: number | null
  amount: number       // CNY
  group: string        // 分组键，多行同组共享备注
  group_note?: string  // 该组的备注文本
}

export interface SettlementHeader {
  order_no: string         // 系统订单号 BO-xxx
  internal_no: string      // 内部订单号（synced_orders.style_no，财务对外口径，抬头优先用它）
  metronome_no: string     // 节拍器号 QM-xxx
  customer_name: string    // S2
  product_name: string     // 瑜伽裤
  quantity: number         // 25680
  quantity_unit: string    // 件
  contract_amount: number  // 79608（合同金额，按订单货币）
  contract_currency: string // USD
  contract_cny: number     // 合同金额折人民币（无实际回款时用于预估毛利，避免收合计=0导致假亏损）
  order_rate: number       // 订单汇率
  order_date: string       // 下单日期
  delivery_date: string    // 交货日期
  completed_at: string     // 2026年3月20日
}

export interface SettlementBundle {
  header: SettlementHeader
  receipts: ReceiptRow[]
  expenses: ExpenseRow[]
  meta: {
    cost_source: 'actual' | 'estimated'  // estimated=从 _cost_breakdown 合成
    receipt_source: 'actual' | 'pending' // pending=无回款记录
  }
}

// ──────────────────────────────────────────────────────────────────
// 数据装配：从订单 + 实际数据组装 bundle
// ──────────────────────────────────────────────────────────────────

interface RawReceipt {
  invoice_date: string | null
  total_amount: number
  currency: string
  exchange_rate: number | null
  supplier_name: string | null
  invoice_no: string | null
}

interface RawExpense {
  cost_type: string
  description: string | null
  supplier: string | null
  cost_group: string | null
  quantity: number | null
  unit: string | null
  unit_price: number | null
  amount: number
  currency: string
  exchange_rate: number | null
  created_at: string
}

const COST_TYPE_LABEL: Record<string, string> = {
  fabric: '面料', accessory: '辅料', processing: '加工费', forwarder: '货代费',
  container: '装柜费', logistics: '物流费', tax: '税费', other: '其他',
  packaging: '包装', hangtag: '吊牌', label: '商标', sample: '样品',
}

function fmtCnDate(s: string | null | undefined): string {
  if (!s) return ''
  const d = s.length >= 10 ? new Date(s.substring(0, 10)) : new Date(s)
  if (isNaN(d.getTime())) return s
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function toCny(amount: number, currency: string, rate: number): number {
  if (currency === 'CNY') return amount
  return new Decimal(amount).mul(rate).toDecimalPlaces(2).toNumber()
}

/**
 * 组装 SettlementBundle —— 调用方（route 或 page）准备好原料后调用本函数
 */
export function buildSettlementBundle(
  order: BudgetOrder & {
    product_name?: string | null; customer_name?: string | null
    internal_no?: string | null; metronome_no?: string | null
    synced_quantity?: number | null; synced_quantity_unit?: string | null
  },
  receipts: RawReceipt[],
  expenses: RawExpense[],
  completedAt: string | null,
): SettlementBundle {
  const orderRate = Number(order.exchange_rate || 1)
  // 数量：items.quantity → items.qty → 节拍器同步数量（与订单详情「基本信息」同口径）
  const firstItem = (order.items as unknown as Record<string, unknown>[])?.[0]
  const itemQty = Number(firstItem?.quantity ?? firstItem?.qty ?? order.synced_quantity ?? 0)

  // 收
  const receiptRows: ReceiptRow[] = receipts.map(r => {
    const rate = Number(r.exchange_rate || orderRate)
    const usd = r.currency === 'USD' ? r.total_amount : 0
    const cny = r.currency === 'CNY' ? r.total_amount : toCny(r.total_amount, r.currency, rate)
    return {
      date: fmtCnDate(r.invoice_date),
      description: r.invoice_no ? `美金货款 ${r.invoice_no}` : '美金货款',
      usd, rate, cny,
      note: r.supplier_name || '',
    }
  })

  // 支
  const expenseRows: ExpenseRow[] = expenses.map(e => {
    const rate = Number(e.exchange_rate || 1)
    const cny = toCny(e.amount, e.currency || 'CNY', rate)
    const group = e.cost_group || COST_TYPE_LABEL[e.cost_type] || e.cost_type
    return {
      date: fmtCnDate(e.created_at),
      description: e.description || COST_TYPE_LABEL[e.cost_type] || e.cost_type,
      supplier: e.supplier || '',
      unit: e.unit || '',
      quantity: e.quantity,
      unit_price: e.unit_price,
      amount: cny,
      group,
    }
  })

  // 计算每组小计 + 写到组最后一条的 group_note
  const groupTotals = new Map<string, number>()
  for (const r of expenseRows) {
    groupTotals.set(r.group, (groupTotals.get(r.group) || 0) + r.amount)
  }
  // 标记每组最后一行附 group_note
  const lastOfGroup = new Map<string, number>()
  expenseRows.forEach((r, i) => lastOfGroup.set(r.group, i))
  for (const [g, idx] of lastOfGroup) {
    const total = groupTotals.get(g) || 0
    expenseRows[idx].group_note = `${g}${new Decimal(total).toDecimalPlaces(2).toString()}元`
  }

  return {
    header: {
      order_no: order.order_no || '',
      internal_no: order.internal_no || '',
      metronome_no: order.metronome_no || '',
      customer_name: (order.customer_name as string) || '',
      product_name: order.product_name || '—',
      quantity: itemQty,
      quantity_unit: order.synced_quantity_unit || '件',
      contract_amount: Number(order.total_revenue || 0),
      contract_currency: order.currency || 'USD',
      contract_cny: order.currency === 'CNY'
        ? Number(order.total_revenue || 0)
        : new Decimal(order.total_revenue || 0).mul(orderRate).toDecimalPlaces(2).toNumber(),
      order_rate: orderRate,
      order_date: fmtCnDate(order.order_date),
      delivery_date: fmtCnDate(order.delivery_date),
      completed_at: fmtCnDate(completedAt),
    },
    receipts: receiptRows,
    expenses: expenseRows,
    meta: {
      cost_source: expenses.length > 0 ? 'actual' : 'estimated',
      receipt_source: receipts.length > 0 ? 'actual' : 'pending',
    },
  }
}

/**
 * 把 BudgetOrder._cost_breakdown 降级合成 expense rows（cost_items 为空时使用）
 */
export function synthesizeExpensesFromBudget(order: BudgetOrder): RawExpense[] {
  const breakdown = (order.items as unknown as Record<string, unknown>[])?.[0]
    ?._cost_breakdown as Record<string, unknown> | undefined
  if (!breakdown) return []
  const map: [string, string][] = [
    ['fabric', '面料'], ['accessory', '辅料'], ['processing', '加工费'],
    ['forwarder', '货代费'], ['container', '装柜费'], ['logistics', '物流费'],
  ]
  const rows: RawExpense[] = []
  for (const [k, label] of map) {
    const amt = Number(breakdown[k] || 0)
    if (amt > 0) rows.push({
      cost_type: k, description: `${label}（预算估算）`,
      supplier: null, cost_group: label,
      quantity: null, unit: null, unit_price: null,
      amount: amt, currency: 'CNY', exchange_rate: 1,
      created_at: new Date().toISOString(),
    })
  }
  const extras = breakdown['extras'] as { name: string; amount: number }[] | undefined
  if (extras) for (const x of extras) {
    if (x.amount > 0) rows.push({
      cost_type: 'other', description: `${x.name}（预算估算）`,
      supplier: null, cost_group: x.name,
      quantity: null, unit: null, unit_price: null,
      amount: x.amount, currency: 'CNY', exchange_rate: 1,
      created_at: new Date().toISOString(),
    })
  }
  return rows
}

// ──────────────────────────────────────────────────────────────────
// Excel 渲染
// ──────────────────────────────────────────────────────────────────

const COMPANY_CN = '义乌市绮陌服饰有限公司'
const COMPANY_EN = 'YIWU QIMO CLOTHING CO.,LTD'
const TITLE = '订单核算单'

type Cell = string | number | null

export function buildSettlementRows(b: SettlementBundle): { rows: Cell[][]; merges: XLSX.Range[] } {
  const rows: Cell[][] = []
  const merges: XLSX.Range[] = []

  // ── 标题（3 行）─────────────────────────────────────────────
  rows.push([COMPANY_CN, null, null, null, null, null, null, null, null]); merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } })
  rows.push([COMPANY_EN, null, null, null, null, null, null, null, null]); merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: 8 } })
  // 抬头带内部订单号（财务对外口径；无内部号时退化为系统单号）
  rows.push([`${TITLE} · ${b.header.internal_no || b.header.order_no}`, null, null, null, null, null, null, null, null]); merges.push({ s: { r: 2, c: 0 }, e: { r: 2, c: 8 } })

  // ── 头部信息块（6 行，A=label，B-I=value 横向合并）──────────
  const headerInfo: [string, Cell][] = [
    ['内部订单号', b.header.internal_no || '—'],
    ['节拍器号',   b.header.metronome_no || '—'],
    ['系统单号',   b.header.order_no],
    ['客户名称',   b.header.customer_name],
    ['品名',       b.header.product_name],
    ['数量',       `${b.header.quantity}${b.header.quantity_unit}`],
    ['合同金额',   b.header.contract_currency === 'USD' ? `$${b.header.contract_amount.toLocaleString()}` : `¥${b.header.contract_amount.toLocaleString()}`],
    ['下单日期',   b.header.order_date || '—'],
    ['交货日期',   b.header.delivery_date || '—'],
    ['订单完结时间', b.header.completed_at || '—'],
  ]
  const headerStartRow = 3
  for (let i = 0; i < headerInfo.length; i++) {
    const [k, v] = headerInfo[i]
    rows.push([k, v, null, null, null, null, null, null, null])
    merges.push({ s: { r: headerStartRow + i, c: 1 }, e: { r: headerStartRow + i, c: 8 } })
  }

  // ── 收 section ─────────────────────────────────────────────
  const shouHeaderRow = rows.length // = 9
  rows.push(['收', '时间', '摘要', null, null, '美金', '汇率', '金额', '备注'])
  merges.push({ s: { r: shouHeaderRow, c: 2 }, e: { r: shouHeaderRow, c: 4 } }) // 摘要 C-E 合并

  const shouDataStart = rows.length
  const receiptsToRender = b.receipts.length > 0 ? b.receipts : [{
    date: '（待回款）', description: '美金货款（按合同预估）',
    usd: b.header.contract_currency === 'CNY' ? 0 : b.header.contract_amount,
    rate: b.header.contract_currency === 'CNY' ? 0 : b.header.order_rate,
    // 用合同金额折人民币填入「收」，避免收合计=0 → 毛利显示为巨额假亏损
    cny: b.header.contract_cny,
    note: b.meta.receipt_source === 'pending' ? '⚠ 尚无实际回款，按合同金额预估（毛利为预估值）' : '',
  }]
  for (const r of receiptsToRender) {
    const rIdx = rows.length
    rows.push([null, r.date, r.description, null, null, r.usd || null, r.rate || null, r.cny || null, r.note])
    merges.push({ s: { r: rIdx, c: 2 }, e: { r: rIdx, c: 4 } }) // 每行摘要 C-E 合并
  }

  // 收合计
  const shouTotalRow = rows.length
  const shouTotalCny = receiptsToRender.reduce((s, r) => s + r.cny, 0)
  rows.push([null, null, '合计', null, null, null, null, shouTotalCny, null])
  merges.push({ s: { r: shouTotalRow, c: 2 }, e: { r: shouTotalRow, c: 4 } })
  merges.push({ s: { r: shouTotalRow, c: 5 }, e: { r: shouTotalRow, c: 6 } }) // 美金+汇率 合并空

  // 收 A 列垂直合并：从 shouHeaderRow 到 shouTotalRow
  merges.push({ s: { r: shouHeaderRow, c: 0 }, e: { r: shouTotalRow, c: 0 } })

  // ── 支 section ─────────────────────────────────────────────
  const zhiHeaderRow = rows.length
  rows.push(['支', '时间', '摘要', '供应商', '单位', '数量', '单价', '金额', '备注'])

  const zhiDataStart = rows.length
  const expensesToRender = b.expenses.length > 0 ? b.expenses : synthesizeExpensesFromBudget({
    items: [] as never, // satisfies TS; real fallback was already done in buildSettlementBundle
  } as never).map(e => ({
    date: '', description: e.description, supplier: '', unit: '',
    quantity: null, unit_price: null, amount: e.amount, group: e.cost_group || '', group_note: undefined,
  } as ExpenseRow))

  // 按 group 顺序排序：保持 group 内连续
  const orderedExpenses = [...expensesToRender].sort((a, b) =>
    a.group === b.group ? 0 : a.group < b.group ? -1 : 1,
  )

  // 同 group 的 group_note 在该组最后一行；多行需合并 I 列
  const groupRanges = new Map<string, { start: number; end: number; note: string }>()
  for (let i = 0; i < orderedExpenses.length; i++) {
    const r = orderedExpenses[i]
    const rIdx = zhiDataStart + i
    rows.push([
      null, r.date, r.description, r.supplier, r.unit,
      r.quantity, r.unit_price, r.amount,
      r.group_note || null,
    ])
    const range = groupRanges.get(r.group)
    if (range) {
      range.end = rIdx
      if (r.group_note) range.note = r.group_note
    } else {
      groupRanges.set(r.group, { start: rIdx, end: rIdx, note: r.group_note || '' })
    }
  }
  // 合并 I 列（备注）每组多行
  for (const { start, end } of groupRanges.values()) {
    if (end > start) merges.push({ s: { r: start, c: 8 }, e: { r: end, c: 8 } })
  }

  // 支合计
  const zhiTotalRow = rows.length
  const zhiTotalCny = orderedExpenses.reduce((s, r) => s + r.amount, 0)
  rows.push([null, null, '合计', null, null, null, null, zhiTotalCny, null])
  merges.push({ s: { r: zhiTotalRow, c: 2 }, e: { r: zhiTotalRow, c: 6 } })

  // 支 A 列垂直合并
  merges.push({ s: { r: zhiHeaderRow, c: 0 }, e: { r: zhiTotalRow, c: 0 } })

  // ── 毛利润 / 毛利率 ────────────────────────────────────────
  const profit = new Decimal(shouTotalCny).sub(zhiTotalCny).toDecimalPlaces(2).toNumber()
  const margin = shouTotalCny > 0
    ? new Decimal(profit).div(shouTotalCny).mul(100).toDecimalPlaces(2).toNumber()
    : 0

  const profitRow = rows.length
  rows.push([null, null, '毛利润', null, null, null, null, profit, null])
  merges.push({ s: { r: profitRow, c: 2 }, e: { r: profitRow, c: 6 } })

  const marginRow = rows.length
  rows.push([null, null, '毛利率', null, null, null, null, `${margin}%`, null])
  merges.push({ s: { r: marginRow, c: 2 }, e: { r: marginRow, c: 6 } })

  // 数据来源提示（如果有降级）
  if (b.meta.cost_source === 'estimated' || b.meta.receipt_source === 'pending') {
    const warnRow = rows.length
    const warnings: string[] = []
    if (b.meta.cost_source === 'estimated') warnings.push('⚠ 支区使用预算估算（实际 cost_items 为空）')
    if (b.meta.receipt_source === 'pending') warnings.push('⚠ 收区尚无实际回款')
    rows.push([warnings.join(' | '), null, null, null, null, null, null, null, null])
    merges.push({ s: { r: warnRow, c: 0 }, e: { r: warnRow, c: 8 } })
  }

  return { rows, merges }
}

/**
 * 导出 Excel 文件 — 浏览器侧调用
 */
export function exportSettlementInvoiceToExcel(bundle: SettlementBundle, fileName?: string): void {
  const { rows, merges } = buildSettlementRows(bundle)
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = merges
  // 列宽
  ws['!cols'] = [
    { wch: 4 },   // A 收/支
    { wch: 13 },  // B 时间
    { wch: 18 },  // C 摘要
    { wch: 16 },  // D 供应商
    { wch: 6 },   // E 单位
    { wch: 10 },  // F 美金/数量
    { wch: 10 },  // G 汇率/单价
    { wch: 14 },  // H 金额
    { wch: 24 },  // I 备注
  ]
  // 行高（标题加高）
  ws['!rows'] = [
    { hpt: 24 }, // 公司中文
    { hpt: 18 }, // EN
    { hpt: 22 }, // 标题
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '核算单')
  // 文件名优先内部订单号（财务对外口径）
  const name = fileName || `${bundle.header.internal_no || bundle.header.order_no || '订单核算单'}_${new Date().toISOString().substring(0, 10)}.xlsx`
  XLSX.writeFile(wb, name)
}

/** 把一个 bundle 变成一张 worksheet（批量导出复用单张的全部排版） */
function bundleToSheet(bundle: SettlementBundle): XLSX.WorkSheet {
  const { rows, merges } = buildSettlementRows(bundle)
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = merges
  ws['!cols'] = [
    { wch: 4 }, { wch: 13 }, { wch: 18 }, { wch: 16 }, { wch: 6 },
    { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 24 },
  ]
  ws['!rows'] = [{ hpt: 24 }, { hpt: 18 }, { hpt: 22 }]
  return ws
}

/**
 * 批量导出：全部订单核算单 → 一个工作簿、一单一 Sheet（对齐财务手工工作簿的习惯）。
 * Sheet 名 = 内部订单号(NO.xxx 风格由财务习惯决定,这里直接用内部单号/订单号)，
 * 去非法字符、截 31 字符（Excel 限制）、重名追加序号。
 */
export function exportSettlementInvoicesWorkbook(bundles: SettlementBundle[], fileName?: string): void {
  if (bundles.length === 0) return
  const wb = XLSX.utils.book_new()
  const used = new Set<string>()
  for (const b of bundles) {
    let base = String(b.header.internal_no || b.header.order_no || '核算单')
      .replace(/[\\/?*[\]:]/g, '-').slice(0, 28) || '核算单'
    let name = base, i = 2
    while (used.has(name)) { name = `${base}(${i++})`.slice(0, 31) }
    used.add(name)
    XLSX.utils.book_append_sheet(wb, bundleToSheet(b), name)
  }
  const name = fileName || `订单核算单汇总_${new Date().toISOString().substring(0, 10)}.xlsx`
  XLSX.writeFile(wb, name)
}

/**
 * 便捷入口：给 page.tsx 用的 一行调用
 *
 *   const bundle = buildSettlementBundle(order, receipts, expenses, completedAt)
 *   exportSettlementInvoiceToExcel(bundle)
 */
