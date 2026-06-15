// ============================================================
// 实时汇率同步 — USD/CNY
// 数据源（免费、无需密钥，双源容灾）：
//   主：open.er-api.com（每日更新）
//   备：api.frankfurter.app（欧央行参考价）
// 写入 exchange_rates 主数据表（source='api'，按 rate_date 幂等 upsert）。
// 触发：每日 cron（orchestrate）+ 手动 POST /api/profit/fx。
// 财务手工录入（source='manual'）优先级更高：同一天已有 manual 记录则不覆盖。
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { bizToday } from '@/lib/biz-date'

const SOURCES = [
  {
    name: 'er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (j: Record<string, unknown>) => Number((j?.rates as Record<string, unknown>)?.CNY) || 0,
  },
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.app/latest?from=USD&to=CNY',
    parse: (j: Record<string, unknown>) => Number((j?.rates as Record<string, unknown>)?.CNY) || 0,
  },
]

export async function fetchLiveUsdCnyRate(): Promise<{ rate: number; source: string } | null> {
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
      if (!res.ok) continue
      const rate = s.parse(await res.json())
      // 合理性护栏：USD/CNY 实际区间外的值一律拒绝（防数据源故障污染主数据）
      if (rate >= 5 && rate <= 10) return { rate: Math.round(rate * 10000) / 10000, source: s.name }
    } catch { /* 切换备用源 */ }
  }
  return null
}

/** 拉取实时汇率并写入主数据表。同日已有财务手工记录则不覆盖（人工 > API）。 */
export async function syncFxRate(supabase: SupabaseClient): Promise<{ ok: boolean; rate?: number; message: string }> {
  const live = await fetchLiveUsdCnyRate()
  if (!live) return { ok: false, message: '所有汇率数据源均不可达，保留主数据表现有汇率' }

  const today = bizToday()
  const { data: existing } = await supabase
    .from('exchange_rates')
    .select('id, source, rate')
    .eq('base_currency', 'USD').eq('quote_currency', 'CNY').eq('rate_date', today)
    .limit(1).maybeSingle()

  if (existing?.source === 'manual') {
    return { ok: true, rate: Number(existing.rate), message: `今日已有财务手工汇率 ${existing.rate}，API 值 ${live.rate} 不覆盖` }
  }
  if (existing) {
    const { error } = await supabase.from('exchange_rates')
      .update({ rate: live.rate, fetched_at: new Date().toISOString(), notes: `来源 ${live.source}` })
      .eq('id', existing.id)
    if (error) return { ok: false, message: `更新失败：${error.message}` }
  } else {
    const { error } = await supabase.from('exchange_rates')
      .insert({ base_currency: 'USD', quote_currency: 'CNY', rate: live.rate, rate_date: today, source: 'api', notes: `来源 ${live.source}` })
    if (error) return { ok: false, message: `写入失败：${error.message}` }
  }
  return { ok: true, rate: live.rate, message: `已同步 USD/CNY = ${live.rate}（${live.source}）` }
}
