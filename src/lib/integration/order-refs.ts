// 采购单 order_refs 归一化(2026-07-09)。
// 节拍器历史发【UUID 字符串数组】order_refs=["<synced_orders.id>", ...];
// 2026-07-09 起改发【富对象数组】order_refs=[{id, order_no, internal_order_no, customer_name}, ...]
// 让财务能直接拿到内部订单号(#2 按内部单号聚合),不再依赖 synced_orders.style_no 解析。
// 本函数同时兼容两种格式(旧库存量是字符串,新事件是对象),所有 order_refs 消费点统一走它。

export interface OrderRef {
  id: string
  order_no: string | null
  internal_order_no: string | null
  customer_name: string | null
}

export function normalizeOrderRefs(raw: unknown): OrderRef[] {
  if (!Array.isArray(raw)) return []
  const out: OrderRef[] = []
  for (const r of raw) {
    if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>
      const id = o.id != null ? String(o.id).trim() : ''
      if (!id) continue
      out.push({
        id,
        order_no: (o.order_no as string) ?? null,
        internal_order_no: (o.internal_order_no as string) ?? null,
        customer_name: (o.customer_name as string) ?? null,
      })
    } else {
      const s = String(r).trim()
      if (s) out.push({ id: s, order_no: null, internal_order_no: null, customer_name: null })
    }
  }
  return out
}
