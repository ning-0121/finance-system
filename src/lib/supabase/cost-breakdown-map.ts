/**
 * 成本桶取数(2026-08-06)
 *
 * ⚠️ 为什么要单独一个函数:
 * getBudgetOrders() 【故意不返回 items】—— 那个 JSONB 里是全部成本明细,
 * 全表拉取会卡死主线程(见 queries.ts:55 的注释,是前人踩过的坑)。
 * 但经营报表 / 成本基准 / 成本完整度都要读 items[0]._cost_breakdown,
 * 拿不到就会静默退回旧标量列,算出来的成本结构与完整度全是错的
 * (2026-08-06 自查发现:页面显示的成本结构、基准、完整度三块此前均为错值)。
 *
 * 折中:只取 id + items 两列(不带 customers join、不带其余标量),
 * 拿到后立刻抽出成本桶、丢弃原始 JSONB,不让大对象停留在内存里。
 * 服务端聚合上线后本函数可退役。
 */
import { createClient } from './client'
import { fetchAll } from './fetch-all'
import { getCostBreakdown } from '@/lib/financial/cost-breakdown'

/** orderId → items[0]._cost_breakdown(原样),供 resolveBucketAmounts 使用 */
export async function getCostBreakdownMap(): Promise<Record<string, Record<string, unknown>>> {
  const sb = createClient()
  const out: Record<string, Record<string, unknown>> = {}
  const { data, error } = await fetchAll<{ id: string; items: unknown }>((from, to) =>
    sb.from('budget_orders').select('id, items').is('deleted_at', null)
      .order('id', { ascending: true }).range(from, to))
  if (error) { console.error('[cost-breakdown-map] 读取失败:', error); return out }
  for (const r of data || []) {
    const cb = getCostBreakdown(r.items)
    if (cb) out[r.id] = cb          // 只留成本桶,原始 items 随本轮循环被回收
  }
  return out
}

/**
 * 把成本桶挂回订单对象,供 resolveBucketAmounts 读取。
 * 约定:resolveBucketAmounts 读的是 order.items[0]._cost_breakdown,
 * 故这里重建一个最小 items 结构,不还原其余明细。
 */
export function attachCostBreakdown<T extends { id: string }>(
  orders: T[],
  map: Record<string, Record<string, unknown>>,
): (T & { items?: unknown })[] {
  return orders.map(o => {
    const cb = map[o.id]
    return cb ? { ...o, items: [{ _cost_breakdown: cb }] } : o
  })
}
