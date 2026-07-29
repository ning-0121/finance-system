// ============================================================
// 历史比价（成本管控）— 录入加工费/布料时，比对历史同款价 + 各供应商报价
// 匹配键：
//   加工费(processing)：按订单的内部款号 style_no 找历史同款加工费单价
//   布料(fabric)：按品名(归一化) + 颜色 找历史同款布料单价
// 只读查询，不改任何金额。单价统一折人民币比较（CNY 行恒 1）。
// ============================================================
import { createClient } from './client'
import { resolveDisplayRate } from '@/lib/accounting/fx'

export interface PriceRefItem {
  supplier: string
  unitPrice: number      // 原币单价
  currency: string
  unitPriceCny: number   // 折人民币单价（比价基准）
  unit: string
  date: string
  orderNo: string
}
export interface PriceReference {
  count: number
  minCny: number
  maxCny: number
  avgCny: number
  items: PriceRefItem[]   // 按日期倒序，最多 20 条
}

const norm = (s: string | null | undefined) => (s || '').normalize('NFKC').replace(/\s+/g, '').trim()
// 外币缺率→市场兜底常量,不再 ||1(审计 2026-07-28:新代码把已收敛的 recurring class 用了回来)
const cnyRate = (currency: string | null, rate: number | null) => resolveDisplayRate(currency, rate)

function summarize(rows: { supplier?: string; unit_price?: number; currency?: string; exchange_rate?: number; unit?: string; created_at?: string; budget_orders?: { order_no?: string } | null }[], excludeId?: string): PriceReference {
  const items: PriceRefItem[] = rows
    .filter(r => r.unit_price != null && Number(r.unit_price) > 0)
    .map(r => {
      const up = Number(r.unit_price) || 0
      return {
        supplier: r.supplier || '未指定',
        unitPrice: up,
        currency: r.currency || 'CNY',
        unitPriceCny: Math.round(up * cnyRate(r.currency || 'CNY', r.exchange_rate ?? 1) * 100) / 100,
        unit: r.unit || '',
        date: (r.created_at || '').slice(0, 10),
        orderNo: r.budget_orders?.order_no || '',
      }
    })
  if (items.length === 0) return { count: 0, minCny: 0, maxCny: 0, avgCny: 0, items: [] }
  const prices = items.map(i => i.unitPriceCny)
  return {
    count: items.length,
    minCny: Math.min(...prices),
    maxCny: Math.max(...prices),
    avgCny: Math.round((prices.reduce((s, p) => s + p, 0) / prices.length) * 100) / 100,
    items: items.slice(0, 20),
  }
}

/** 布料：按品名(归一化)+颜色 找历史同款单价 */
export async function getFabricPriceReference(description: string, color: string, excludeOrderId?: string): Promise<PriceReference> {
  const key = norm(description)
  if (!key) return { count: 0, minCny: 0, maxCny: 0, avgCny: 0, items: [] }
  const supabase = createClient()
  const { data } = await supabase.from('cost_items')
    .select('supplier, unit_price, currency, exchange_rate, unit, color, description, created_at, budget_order_id, budget_orders(order_no)')
    .eq('cost_type', 'fabric').is('deleted_at', null).not('unit_price', 'is', null)
    .ilike('description', `%${description.trim().slice(0, 20)}%`)
    .order('created_at', { ascending: false }).limit(500)
  const wantColor = norm(color)
  const rows = (data || []).filter(r => {
    if (norm(r.description as string) !== key) return false
    if (wantColor && norm(r.color as string) !== wantColor) return false   // 填了颜色才按颜色筛
    if (excludeOrderId && r.budget_order_id === excludeOrderId) return false
    return true
  })
  return summarize(rows as never)
}

/** 加工费：按订单的内部款号 style_no 找历史同款加工费单价 */
export async function getProcessingPriceReference(orderId: string, excludeOrderId?: string): Promise<PriceReference> {
  if (!orderId) return { count: 0, minCny: 0, maxCny: 0, avgCny: 0, items: [] }
  const supabase = createClient()
  // 1) 该订单的款号
  const { data: self } = await supabase.from('synced_orders').select('style_no').eq('budget_order_id', orderId).limit(1).maybeSingle()
  const styleNo = (self?.style_no as string || '').trim()
  if (!styleNo) return { count: 0, minCny: 0, maxCny: 0, avgCny: 0, items: [] }
  // 2) 同款号的所有订单
  const { data: sameStyle } = await supabase.from('synced_orders').select('budget_order_id').eq('style_no', styleNo).limit(500)
  const orderIds = [...new Set((sameStyle || []).map(s => s.budget_order_id as string).filter(Boolean))]
  if (orderIds.length === 0) return { count: 0, minCny: 0, maxCny: 0, avgCny: 0, items: [] }
  // 3) 这些订单的加工费明细
  const rows: unknown[] = []
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data } = await supabase.from('cost_items')
      .select('supplier, unit_price, currency, exchange_rate, unit, created_at, budget_order_id, budget_orders(order_no)')
      .eq('cost_type', 'processing').is('deleted_at', null).not('unit_price', 'is', null)
      .in('budget_order_id', orderIds.slice(i, i + 200)).order('created_at', { ascending: false }).limit(500)
    rows.push(...(data || []))
  }
  const filtered = (rows as { budget_order_id?: string }[]).filter(r => !(excludeOrderId && r.budget_order_id === excludeOrderId))
  return summarize(filtered as never)
}

// ============================================================
// 功能1(2026-07-28):按产品(款号)搜索——跨订单聚合客户PO价 / 加工费 / 利润率 + PO号 + 下单日期。
// 款号自由文本,用 norm() 归一化匹配(大小写/空格不影响);一订单一行,按下单日期倒序。
// ============================================================
export interface ProductPriceRow {
  budgetOrderId: string
  qmOrderNo: string | null         // 节拍器订单号 QM-xxx
  poNumber: string | null          // 客户PO号
  customerName: string | null
  orderDate: string | null         // 下单日期
  currency: string
  poUnitPrice: number | null       // 客户PO单价(原币)
  quantity: number | null
  processingCny: number | null     // 加工费合计(折人民币)
  margin: number | null            // 利润率 %
}
export interface ProductPriceResult {
  keyword: string
  count: number
  rows: ProductPriceRow[]
}

export async function getProductPriceHistory(keyword: string): Promise<ProductPriceResult> {
  const key = norm(keyword)
  if (!key) return { keyword, count: 0, rows: [] }
  const supabase = createClient()
  // 1) 匹配款号的 synced_orders(ilike 粗筛 → norm 精确,避免大小写/空格漏聚合)
  const { data: so } = await supabase.from('synced_orders')
    .select('id, order_no, style_no, po_number, unit_price, quantity, currency, customer_name, budget_order_id, source_created_at')
    .ilike('style_no', `%${keyword.trim().slice(0, 30)}%`)
    .order('source_created_at', { ascending: false }).order('id', { ascending: true })   // 稳定排序(P1-6:拆单取行不再随缘)
    .limit(1000)
  const matched = (so || []).filter(s => norm(s.style_no as string) === key && s.budget_order_id)
  if (matched.length === 0) return { keyword, count: 0, rows: [] }
  const boIds = [...new Set(matched.map(s => s.budget_order_id as string))]

  // 2) budget_orders:下单日期 / 利润率 / 总收入(PO单价缺失时用 总收入÷数量 兜底)
  const { data: bos } = await supabase.from('budget_orders')
    .select('id, order_date, estimated_margin, total_revenue').in('id', boIds).is('deleted_at', null)
  const boMap = new Map((bos || []).map(b => [b.id as string, b as { order_date?: string; estimated_margin?: number; total_revenue?: number }]))

  // 3) 加工费:cost_items processing 按订单汇总(折人民币)
  const procByOrder = new Map<string, number>()
  for (let i = 0; i < boIds.length; i += 200) {
    const { data: ci } = await supabase.from('cost_items')
      .select('budget_order_id, amount, currency, exchange_rate')
      .eq('cost_type', 'processing').is('deleted_at', null).in('budget_order_id', boIds.slice(i, i + 200))
    for (const c of (ci || []) as { budget_order_id: string; amount: number; currency: string; exchange_rate: number }[]) {
      const cny = (Number(c.amount) || 0) * cnyRate(c.currency, c.exchange_rate)
      procByOrder.set(c.budget_order_id, Math.round(((procByOrder.get(c.budget_order_id) || 0) + cny) * 100) / 100)
    }
  }

  // 4) 一订单一行(按 budget_order_id 分组)。拆单/多 synced 行时:优先取【带单价】的行(P1-6,不再随缘);
  //    数量与兜底单价的分母用组内数量合计(拆单行数量偏小会把兜底单价虚高)。
  const byBo = new Map<string, typeof matched>()
  for (const s of matched) {
    const boId = s.budget_order_id as string
    if (!byBo.has(boId)) byBo.set(boId, [])
    byBo.get(boId)!.push(s)
  }
  const rows: ProductPriceRow[] = []
  for (const [boId, group] of byBo) {
    const s = group.find(g => g.unit_price != null) || group[0]
    const qtySum = group.reduce((t, g) => t + (Number(g.quantity) || 0), 0)
    const bo = boMap.get(boId)
    rows.push({
      budgetOrderId: boId,
      qmOrderNo: (s.order_no as string) || null,
      poNumber: (s.po_number as string) || null,
      customerName: (s.customer_name as string) || null,
      orderDate: (bo?.order_date as string) || (s.source_created_at ? String(s.source_created_at).slice(0, 10) : null),
      currency: (s.currency as string) || 'CNY',
      poUnitPrice: s.unit_price != null ? Number(s.unit_price)
        : (bo?.total_revenue != null && qtySum > 0
            ? Math.round((Number(bo.total_revenue) / qtySum) * 100) / 100 : null),  // PO单价缺→总收入÷组内数量合计兜底
      quantity: qtySum > 0 ? qtySum : (s.quantity != null ? Number(s.quantity) : null),
      processingCny: procByOrder.get(boId) ?? null,
      margin: bo?.estimated_margin != null ? Number(bo.estimated_margin) : null,
    })
  }
  rows.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''))
  return { keyword, count: rows.length, rows }
}
