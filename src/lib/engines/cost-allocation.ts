import type { BudgetOrder } from '@/lib/types'

/** 订单明细行件数合计，用于多订单分摊权重 */
export function orderTotalQty(order: BudgetOrder): number {
  return order.items?.reduce((s, i) => s + (Number(i.qty) || 0), 0) ?? 0
}

/**
 * 将一笔费用总额按多个订单的件数比例拆分；若件数均为 0 则平均分摊。
 * 最后一笔承担舍入差额，保证合计等于 totalAmount。
 */
export function allocateAmountByOrderQty(
  totalAmount: number,
  orderIds: string[],
  orders: BudgetOrder[],
): { orderId: string; amount: number; qty: number }[] {
  const n = orderIds.length
  if (n === 0 || totalAmount <= 0) return []

  const rows = orderIds.map(orderId => {
    const o = orders.find(x => x.id === orderId)
    const qty = o ? orderTotalQty(o) : 0
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
