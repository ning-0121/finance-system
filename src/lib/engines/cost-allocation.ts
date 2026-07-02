/**
 * 将一笔费用总额按多个订单的数量比例拆分；若数量均为 0 则平均分摊。
 * 最后一笔承担舍入差额，保证合计等于 totalAmount。
 * 权重来源：synced_orders.quantity（budget_orders.items 里不含数量，早期用 items.qty 恒为 0）。
 * qtyById：budget_order_id → 订单数量。
 */
export function allocateAmountByOrderQty(
  totalAmount: number,
  orderIds: string[],
  qtyById: Record<string, number>,
): { orderId: string; amount: number; qty: number }[] {
  const n = orderIds.length
  if (n === 0 || totalAmount <= 0) return []

  const rows = orderIds.map(orderId => {
    const qty = Math.max(0, Number(qtyById[orderId]) || 0)
    return { orderId, qty }
  })

  const sumQty = rows.reduce((s, r) => s + r.qty, 0)

  if (sumQty <= 0) {
    const base = Math.floor((totalAmount * 100) / n) / 100
    let running = 0
    return rows.map((row, i) => {
      const amount = i === n - 1 ? Math.round((totalAmount - running) * 100) / 100 : base
      running += amount
      return { orderId: row.orderId, qty: row.qty, amount }
    })
  }

  let allocated = 0
  return rows.map((row, i) => {
    if (i === n - 1) {
      return {
        orderId: row.orderId,
        qty: row.qty,
        amount: Math.round((totalAmount - allocated) * 100) / 100,
      }
    }
    const raw = totalAmount * (row.qty / sumQty)
    const amount = Math.round(raw * 100) / 100
    allocated += amount
    return { orderId: row.orderId, qty: row.qty, amount }
  })
}
