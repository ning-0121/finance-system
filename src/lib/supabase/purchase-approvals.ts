// 采购单审批(≥¥5000)· 查询层
import { createClient } from './client'
import { fetchAll } from './fetch-all'

export interface PendingPO {
  id: string
  purchase_order_id: string
  po_no: string
  supplier_id: string | null
  supplier_name: string | null
  total_amount: number | null
  currency: string
  delivery_date: string | null
  placed_at: string | null
  payment_terms: string | null
  order_refs: unknown
  requires_approval: boolean | null
}

export interface PoLine {
  id: string
  line_id: string
  order_no: string | null
  internal_order_no: string | null
  style_no: string | null
  material_name: string | null
  material_code: string | null
  specification: string | null
  category: string | null
  ordered_qty: number | null
  ordered_unit: string | null
  unit_price: number | null
  amount: number | null
}

// 某原辅料的历史采购价一条记录
export interface PriceHistoryRow {
  po_no: string | null
  supplier_name: string | null
  placed_at: string | null
  unit_price: number | null
  ordered_unit: string | null
  ordered_qty: number | null
  amount: number | null
  specification: string | null
}

export async function getPendingPurchaseApprovals(): Promise<PendingPO[]> {
  try {
    const sb = createClient()
    const { data } = await fetchAll<PendingPO>((from, to) =>
      sb.from('fin_purchase_orders')
        .select('id, purchase_order_id, po_no, supplier_id, supplier_name, total_amount, currency, delivery_date, placed_at, payment_terms, order_refs, requires_approval')
        .eq('fin_status', 'pending_approval').is('deleted_at', null)
        .order('placed_at', { ascending: true, nullsFirst: true }).order('id', { ascending: true }).range(from, to))
    return data || []
  } catch { return [] }
}

export async function getPoLines(finPoId: string): Promise<PoLine[]> {
  try {
    const sb = createClient()
    const { data } = await fetchAll<PoLine>((from, to) =>
      sb.from('fin_po_lines')
        .select('id, line_id, order_no, internal_order_no, style_no, material_name, material_code, specification, category, ordered_qty, ordered_unit, unit_price, amount')
        .eq('fin_po_id', finPoId).range(from, to))
    return data || []
  } catch { return [] }
}

// 历史采购价:同一原辅料(优先 material_code,回退 material_name)过去买过几次、谁家、什么价。
// 排除当前采购单自身的行(excludeFinPoId)。按下单时间倒序,最近的在前。
export async function getMaterialPriceHistory(
  material: { material_code?: string | null; material_name?: string | null },
  excludeFinPoId?: string,
): Promise<PriceHistoryRow[]> {
  try {
    const sb = createClient()
    const code = (material.material_code || '').trim()
    const name = (material.material_name || '').trim()
    if (!code && !name) return []

    // 1. 命中的历史采购行(带其 fin_po_id + 价格)。审计P2:无 code 时按名【等值】匹配,
    //    不用 ilike——否则物料名里的 %/_ 会被当通配符,串到其它物料的历史价、误导审批。
    const { data: lines } = await fetchAll<{ fin_po_id: string; unit_price: number | null; ordered_unit: string | null; ordered_qty: number | null; amount: number | null; specification: string | null }>((from, to) => {
      let q = sb.from('fin_po_lines')
        .select('fin_po_id, unit_price, ordered_unit, ordered_qty, amount, specification')
      q = code ? q.eq('material_code', code) : q.eq('material_name', name)
      return q.range(from, to)
    })
    if (!lines || lines.length === 0) return []

    // 2. 取这些采购单头(供应商/单号/下单日) —— 两步查,不依赖 PostgREST FK 嵌入
    const poIds = [...new Set(lines.map(l => l.fin_po_id).filter(Boolean))]
    const { data: pos } = await fetchAll<{ id: string; po_no: string | null; supplier_name: string | null; placed_at: string | null }>((from, to) =>
      sb.from('fin_purchase_orders').select('id, po_no, supplier_name, placed_at').in('id', poIds).is('deleted_at', null).range(from, to))
    const poMap = new Map((pos || []).map(p => [p.id, p]))

    const rows: PriceHistoryRow[] = lines
      .filter(l => l.fin_po_id !== excludeFinPoId && poMap.has(l.fin_po_id))
      .map(l => {
        const p = poMap.get(l.fin_po_id)!
        return {
          po_no: p.po_no, supplier_name: p.supplier_name, placed_at: p.placed_at,
          unit_price: l.unit_price, ordered_unit: l.ordered_unit, ordered_qty: l.ordered_qty,
          amount: l.amount, specification: l.specification,
        }
      })
      .sort((a, b) => (b.placed_at || '').localeCompare(a.placed_at || ''))
    return rows
  } catch { return [] }
}

// 批准/驳回 → 走服务端 API(需回传节拍器、需服务端密钥)
export async function decidePurchaseApproval(
  purchase_order_id: string, decision: 'approved' | 'rejected', note?: string,
): Promise<{ ok: boolean; error?: string; callback?: string; callback_error?: string; po_no?: string }> {
  try {
    const res = await fetch('/api/purchase-approvals/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchase_order_id, decision, note }),
    })
    const json = await res.json()
    if (!res.ok) return { ok: false, error: json.error || `HTTP ${res.status}` }
    return { ok: true, ...json }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '网络错误' }
  }
}
