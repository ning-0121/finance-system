/**
 * AI 日花费硬性封顶(2026-07-23 · 财务系统)。
 * 每次调 Anthropic 前查当日累计花费(全系统合计),达上限则抛 AiBudgetExceeded
 * (暂停调用,次日 UTC 归零自动恢复)。上限可配:
 *   app_config.ai_daily_cap_usd 覆盖 env AI_DAILY_CAP_USD,默认 $5。
 * 表 ai_spend_log 未建(迁移未跑)时 fail-open 放行,绝不因封顶自身阻断业务。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'

const DEFAULT_CAP_USD = Number(process.env.AI_DAILY_CAP_USD) || 5

// 价格($/百万 token),保守取列表价(略高→提前封顶更安全)
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus': { in: 5, out: 25 },
  'claude-haiku': { in: 1, out: 5 },
}
function priceFor(model: string) {
  const k = Object.keys(PRICE).find((p) => (model || '').startsWith(p))
  return PRICE[k || ''] || { in: 3, out: 15 }
}
export function estimateCost(model: string, inTok: number, outTok: number): number {
  const p = priceFor(model)
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out
}

function todayUTC(): string { return new Date().toISOString().slice(0, 10) }

export class AiBudgetExceeded extends Error {
  constructor(public spent: number, public cap: number) {
    super(`今日 AI 花费已达上限 $${cap}(已花 $${spent.toFixed(2)}),暂停调用,次日自动恢复`)
    this.name = 'AiBudgetExceeded'
  }
}

/** 达上限则抛 AiBudgetExceeded;表不存在/查询失败则放行(fail-open)。 */
export async function assertDailyBudget(): Promise<void> {
  let sb: ReturnType<typeof createServiceClient>
  try { sb = createServiceClient() } catch { return }
  let cap = DEFAULT_CAP_USD
  try {
    const { data: cfg } = await (sb.from('app_config') as any).select('ai_daily_cap_usd').eq('id', 'singleton').maybeSingle()
    if (typeof cfg?.ai_daily_cap_usd === 'number') cap = cfg.ai_daily_cap_usd
  } catch { /* 用默认 */ }
  const { data, error } = await (sb.from('ai_spend_log') as any).select('cost_usd').eq('spend_date', todayUTC())
  if (error) return // 表未建等 → 放行
  const spent = (data || []).reduce((s: number, r: any) => s + (Number(r.cost_usd) || 0), 0)
  if (spent >= cap) throw new AiBudgetExceeded(spent, cap)
}

/** 记一次花费(fail-safe,不阻断)。 */
export async function recordSpend(model: string, inTok: number, outTok: number, scene?: string): Promise<void> {
  try {
    const sb = createServiceClient()
    await (sb.from('ai_spend_log') as any).insert({ spend_date: todayUTC(), cost_usd: estimateCost(model, inTok, outTok), model, scene: scene || null })
  } catch { /* 记账失败不阻断 */ }
}

/**
 * 封顶包装:调用前查预算(超则抛 AiBudgetExceeded),调用后记账。
 * 用法:把 `await client.messages.create(params)` 换成 `await createWithBudget(client, params, 'scene')`。
 */
export async function createWithBudget(
  client: { messages: { create: (p: any, o?: any) => Promise<any> } },
  params: any,
  scene?: string,
  options?: any,
): Promise<Anthropic.Message> {
  await assertDailyBudget()
  const response = (await client.messages.create(params, options)) as Anthropic.Message
  const u = response?.usage as any
  await recordSpend(response?.model || params?.model, u?.input_tokens ?? 0, u?.output_tokens ?? 0, scene)
  return response
}
