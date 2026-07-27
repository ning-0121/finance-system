// ============================================================
// 统一汇率折算(审计 2026-07-27:收敛散落的 ||1 / ||7 / 6.9 / 7.2 / 7.15 兜底)
//
// 策略(老板 2026-07-27 拍板 = 市场汇率兜底):
//   外币缺汇率时,用 exchange_rates 表【最新市场汇率】兜底折算(真实源),
//   绝不用 ||1(把外币当人民币,最危险);表也空时才用文档化的单一常量 FX_LAST_RESORT。
//   记账路径(GL 过账)不在此列 —— 仍用 requireRate(缺率抛错,见 utils.ts),绝不臆造汇率入账本。
//   本模块只服务【展示/报表】层。
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

// exchange_rates 表也空时的最后兜底(唯一文档化常量,替代散落的 7 / 6.9 / 7.15 / 7.24)
export const FX_LAST_RESORT = 7.2

/**
 * 取最新市场汇率(base→CNY),供展示层给「外币缺率」做兜底折算。
 * 表有数据 → 用最新一条;表空/查询失败 → 用 FX_LAST_RESORT 并置 estimated=true(供 UI 标「估算」)。
 * 页面在数据加载时调一次,把 rate 传给下面的同步折算函数(避免每行都 await)。
 */
export async function getMarketRate(
  supabase: SupabaseClient,
  base: string = 'USD',
): Promise<{ rate: number; estimated: boolean }> {
  if (!base || base.toUpperCase() === 'CNY') return { rate: 1, estimated: false }
  try {
    const { data } = await supabase
      .from('exchange_rates')
      .select('rate')
      .eq('base_currency', base.toUpperCase())
      .eq('quote_currency', 'CNY')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const r = Number((data as { rate?: number } | null)?.rate)
    if (r > 0) return { rate: r, estimated: false }
  } catch { /* 表缺失/查询失败 → 落到最后兜底 */ }
  return { rate: FX_LAST_RESORT, estimated: true }
}

/**
 * 展示层折算汇率(替代全站内联的 `currency==='CNY' ? 1 : (rate || 1)` / `|| 7` 等):
 *   CNY → 1;外币有有效汇率 → 用之;外币缺率 → 用传入的市场兜底汇率(绝不 1)。
 * marketFallback 由页面用 getMarketRate 预载一次后传入。
 */
export function resolveDisplayRate(
  currency: string | null | undefined,
  rate: number | null | undefined,
  marketFallback: number,
): number {
  if (!currency || currency.toUpperCase() === 'CNY') return 1
  const r = Number(rate)
  if (r > 0) return r
  return marketFallback > 0 ? marketFallback : FX_LAST_RESORT
}

/** 折算金额到 CNY(展示层)。amount × resolveDisplayRate(...)。 */
export function toCnyDisplay(
  amount: number | null | undefined,
  currency: string | null | undefined,
  rate: number | null | undefined,
  marketFallback: number,
): number {
  return (Number(amount) || 0) * resolveDisplayRate(currency, rate, marketFallback)
}
