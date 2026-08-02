/**
 * 订单预估利润 / 毛利率的唯一推导口径(2026-08-02)
 *
 * ⚠️ 为什么要「现算」而不是读列:
 *   `budget_orders.estimated_profit / estimated_margin` 是保存时算好写进去的快照列。
 *   凡是绕过订单页保存的入库路径(Excel 核算单批量导入、节拍器同步建单…)只回填了
 *   收入与成本、没算利润 —— 于是列里存着 0。而订单列表直接读这两列,
 *   结果:478 张有收入有成本的单在列表上显示「利润 ¥0 / 毛利率 0%」(审计 2026-08-02)。
 *   靠"再补一次回填"治不住:下一个新写入方照样会忘。所以改成读时推导。
 *
 * 口径(与订单页保存一致):
 *   收入CNY = 人民币单直接取 total_revenue;外币单 = total_revenue × exchange_rate
 *   利润CNY = 收入CNY − total_cost      (total_cost 全站约定已是 CNY)
 *   毛利率  = 利润CNY / 收入CNY × 100
 *
 * ⚠️ 外币缺汇率时【不猜、不按 1:1】:返回 usable=false,由 UI 显示「缺汇率」。
 *    按 1:1 折算会把 $1 当 ¥1,毛利率直接失真(审计反复出现的 ||1 类坑)。
 */

const num = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100

export interface OrderProfit {
  /** 能否算出利润;false 时 profitCny/marginPct 无意义,UI 应显示原因而非 0 */
  usable: boolean
  reason?: 'missing_rate' | 'no_revenue'
  revenueCny: number
  costCny: number
  profitCny: number
  marginPct: number
}

export interface ProfitInput {
  currency?: string | null
  exchange_rate?: number | string | null
  total_revenue?: number | string | null
  total_cost?: number | string | null
}

/** 按订单自身币种与汇率推导预估利润。外币缺率 → usable=false。 */
export function computeOrderProfit(o: ProfitInput | null | undefined): OrderProfit {
  const cur = String(o?.currency || 'CNY').toUpperCase()
  const revenue = num(o?.total_revenue)
  const costCny = r2(num(o?.total_cost))
  const isCny = cur === 'CNY' || cur === 'RMB'
  const rate = num(o?.exchange_rate)

  if (!isCny && !(rate > 0)) {
    return { usable: false, reason: 'missing_rate', revenueCny: 0, costCny, profitCny: 0, marginPct: 0 }
  }
  const revenueCny = r2(isCny ? revenue : revenue * rate)
  const profitCny = r2(revenueCny - costCny)
  const marginPct = revenueCny > 0 ? r2((profitCny / revenueCny) * 100) : 0
  return {
    usable: revenueCny > 0 || costCny > 0,
    reason: revenueCny > 0 ? undefined : 'no_revenue',
    revenueCny, costCny, profitCny, marginPct,
  }
}

/**
 * 列表/排序用的「有效」利润:
 * 决算已确认 → 用实际决算数;否则按订单现算预估。
 * 存量快照列(estimated_profit)只在现算不可用时兜底,不再作为首选。
 */
export function effectiveProfit(
  order: ProfitInput & { estimated_profit?: number | string | null },
  settlement?: { status?: string | null; final_profit?: number | null } | null,
): number {
  if (settlement && (settlement.status === 'confirmed' || settlement.status === 'locked')) {
    return num(settlement.final_profit)
  }
  const c = computeOrderProfit(order)
  return c.usable ? c.profitCny : num(order?.estimated_profit)
}

export function effectiveMargin(
  order: ProfitInput & { estimated_margin?: number | string | null },
  settlement?: { status?: string | null; final_margin?: number | null } | null,
): number {
  if (settlement && (settlement.status === 'confirmed' || settlement.status === 'locked')) {
    return num(settlement.final_margin)
  }
  const c = computeOrderProfit(order)
  return c.usable ? c.marginPct : num(order?.estimated_margin)
}
