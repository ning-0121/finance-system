// 采购单审批(≥¥5000)· 查询层
import { createClient } from './client'
import { fetchAll } from './fetch-all'
import { normalizeOrderRefs } from '@/lib/integration/order-refs'

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
  internal_order_no?: string | null   // 内部/工厂单号(order_refs → synced_orders.style_no),#2 分组键
  qm_order_no?: string | null         // 节拍器订单号 QM-xxx
  order_deleted?: boolean             // 关联订单是否已删除/取消(全删则过滤出队列)
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
  color: string | null       // 颜色(同料多色行按色核数量;需迁移 20260711_fin_po_lines_color_size)
  size: string | null        // 尺码
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
    const pos = data || []
    if (!pos.length) return pos
    // order_refs → 内部单号/QM号/是否已删。用于 #2 按内部单号分组 + #1 过滤已删订单的采购单。
    // 2026-07-09:内部单号优先取 order_refs 富对象自带(节拍器新事件),退回 synced_orders(旧库存字符串数组)。
    // 只用 UUID 形态的 id 去查 synced_orders.id —— 历史 order_refs 可能混入 QM 单号(非 UUID),
    // 直接 .in('id', [...]) 会 22P02 400 → 外层 catch 吞成 []→整个审批队列凭空消失(验证 2026-07-09 实测发现)。
    const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    const refs = [...new Set(pos.flatMap(p => normalizeOrderRefs(p.order_refs).map(r => r.id)))].filter(isUuid)
    const orderMap: Record<string, { qm: string | null; internal: string | null; deleted: boolean }> = {}
    if (refs.length) {
      const { data: so } = await sb.from('synced_orders')
        .select('id, order_no, style_no, lifecycle_status').in('id', refs)
      for (const s of (so as Record<string, unknown>[] | null) || []) {
        const life = String(s.lifecycle_status || '')
        orderMap[String(s.id)] = {
          qm: (s.order_no as string) || null,
          internal: (s.style_no as string) || null,
          deleted: ['deleted', 'cancelled', '已取消', '已删除'].includes(life),
        }
      }
    }
    const enriched = pos.map(p => {
      const nrefs = normalizeOrderRefs(p.order_refs)
      const infos = nrefs.map(r => orderMap[r.id]).filter(Boolean)
      return {
        ...p,
        // 富对象自带内部单号优先(不依赖 synced_orders 是否已同步/style_no 是否为空)
        internal_order_no: nrefs.map(r => r.internal_order_no).find(Boolean)
          || infos.map(i => i.internal).find(Boolean) || null,
        qm_order_no: nrefs.map(r => r.order_no).find(Boolean)
          || infos.map(i => i.qm).find(Boolean) || null,
        // 仅当所有关联订单都已删/取消才算废单(部分关联仍在则保留,避免误藏)
        order_deleted: infos.length > 0 && infos.every(i => i.deleted),
      }
    })
    return enriched.filter(p => !p.order_deleted)   // #1:关联订单已删的采购单不再占审批队列
  } catch { return [] }
}

export async function getPoLines(finPoId: string): Promise<PoLine[]> {
  const base = 'id, line_id, order_no, internal_order_no, style_no, material_name, material_code, specification, category, ordered_qty, ordered_unit, unit_price, amount'
  const sb = createClient()
  // 先带 color/size 查;迁移 20260711_fin_po_lines_color_size 未跑时列不存在会 400 → 降级不带,明细不能整个消失
  try {
    const { data, error } = await fetchAll<PoLine>((from, to) =>
      sb.from('fin_po_lines').select(`${base}, color, size`).eq('fin_po_id', finPoId).range(from, to))
    if (!error && data) return data
  } catch { /* 降级 */ }
  try {
    const { data } = await fetchAll<Omit<PoLine, 'color' | 'size'>>((from, to) =>
      sb.from('fin_po_lines').select(base).eq('fin_po_id', finPoId).range(from, to))
    return (data || []).map(l => ({ ...l, color: null, size: null }))
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

// ── PO 附件 + 报价单识别 + 预算草稿(2026-07-11 PO审批预算链) ──────

export interface PoAttachment {
  id: string
  file_name: string
  file_type: string | null
  file_url: string | null
  doc_hint: string | null           // 'po' | 'internal_quote' | null
  status: string
  related_qimo_order_id: string | null
  extracted_fields: Record<string, unknown> | null
}

/** 成本桶(与预算 _cost_breakdown.lines 分组键一致;客户端安全,勿从 quote-extractor 引 —— 那边拖 Anthropic SDK) */
export const BUCKET_LABELS: Record<string, string> = {
  fabric: '面料', accessory: '辅料', processing: '加工费', freight: '运费',
  commission: '佣金', customs: '报关/关税', other: '其他',
}

export interface QuoteCostLineUI { bucket: string; name: string; supplier?: string | null; qty?: number | null; unit?: string | null; unit_price?: number | null; amount: number }
export interface QuoteStyleUI { style_label: string; sell_price?: number | null; unit_cost?: number | null; cost_lines: QuoteCostLineUI[] }
export interface QuoteResultUI {
  success: boolean
  order_no?: string | null; style_no?: string | null; customer_name?: string | null
  quantity?: number | null; unit?: string | null
  sell_price?: number | null; currency?: string | null; total_revenue?: number | null
  exchange_rate?: number | null
  per_unit?: boolean            // 单件成本口径(金额=每件人民币,预算要×订单数量)
  styles?: QuoteStyleUI[]       // 多款核算单:一款一组
  cost_lines: QuoteCostLineUI[]
  cost_total?: number | null
  raw_text_summary?: string
}

/** 该采购单关联的附件(节拍器随 PO 推送或 file.uploaded 补发) */
export async function getPoAttachments(purchaseOrderId: string): Promise<PoAttachment[]> {
  try {
    const sb = createClient()
    const { data } = await sb.from('uploaded_documents')
      .select('id, file_name, file_type, file_url, doc_hint, status, related_qimo_order_id, extracted_fields')
      .eq('related_purchase_order_id', purchaseOrderId)
      .order('created_at', { ascending: true })
    return (data as PoAttachment[]) || []
  } catch { return [] }
}

/** 该订单(节拍器 orders.id)关联的附件 —— 客户PO单据/内部报价单(订单级 PO 审批用) */
export async function getOrderAttachments(qimoOrderId: string): Promise<PoAttachment[]> {
  try {
    const sb = createClient()
    const { data } = await sb.from('uploaded_documents')
      .select('id, file_name, file_type, file_url, doc_hint, status, related_qimo_order_id, extracted_fields')
      .eq('related_qimo_order_id', qimoOrderId)
      .order('created_at', { ascending: true })
    return (data as PoAttachment[]) || []
  } catch { return [] }
}

/** 触发/读取报价单识别(服务端按需调 AI;已识别过直接回缓存) */
export async function extractQuote(documentId: string, force = false): Promise<{ ok: boolean; quote?: QuoteResultUI; error?: string }> {
  try {
    const res = await fetch('/api/purchase-approvals/extract-quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_id: documentId, force }),
    })
    const json = await res.json()
    if (!res.ok) return { ok: false, error: json.error || `HTTP ${res.status}` }
    return { ok: true, quote: json.quote as QuoteResultUI }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '网络错误' } }
}

/** 财务调价确认后建预算草稿(真实登录人落库) */
export async function createBudgetFromQuote(params: {
  syncedOrderId: string
  revenue: number; currency: string; exchangeRate: number | null
  quantity: number | null; unit?: string | null
  costLines: QuoteCostLineUI[]
  sourceDocumentId?: string | null
  purchaseOrderId?: string | null
  notes?: string
}): Promise<{ ok: boolean; budgetOrderId?: string; error?: string }> {
  try {
    const res = await fetch('/api/purchase-approvals/create-budget-from-quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const json = await res.json()
    if (!res.ok) return { ok: false, error: json.error || `HTTP ${res.status}` }
    return { ok: true, budgetOrderId: json.budgetOrderId }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : '网络错误' } }
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
