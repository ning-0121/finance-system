// 人工覆盖引擎 — 当自动化做错时，人可以覆盖但留痕迹
import { createClient } from '@/lib/supabase/client'
import { recordTimelineEvent } from './timeline-engine'

export interface ManualOverride {
  id: string
  override_type: string
  entity_type: string
  entity_id: string
  original_state: Record<string, unknown> | null
  new_state: Record<string, unknown> | null
  reason: string
  overridden_by: string | null
  overridden_at: string
  rule_id: string | null
  impact_assessment: string | null
}

/**
 * 创建人工覆盖记录
 */
export async function createOverride(params: {
  overrideType: string
  entityType: string
  entityId: string
  originalState?: Record<string, unknown>
  newState?: Record<string, unknown>
  reason: string
  overriddenBy?: string
  ruleId?: string
  impactAssessment?: string
}): Promise<{ success: boolean; overrideId?: string; error?: string }> {
  const supabase = createClient()

  let overriddenBy = params.overriddenBy
  if (!overriddenBy) {
    const { data: { user } } = await supabase.auth.getUser()
    overriddenBy = user?.id
  }

  const { data, error } = await supabase
    .from('manual_overrides')
    .insert({
      override_type: params.overrideType,
      entity_type: params.entityType,
      entity_id: params.entityId,
      original_state: params.originalState || null,
      new_state: params.newState || null,
      reason: params.reason,
      overridden_by: overriddenBy,
      rule_id: params.ruleId || null,
      impact_assessment: params.impactAssessment || null,
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }

  // 记录时间线
  await recordTimelineEvent({
    entityType: params.entityType,
    entityId: params.entityId,
    eventType: 'manual_override',
    eventTitle: `人工覆盖: ${params.overrideType}`,
    eventDetail: {
      override_type: params.overrideType,
      reason: params.reason,
      rule_id: params.ruleId,
    },
    sourceType: 'user',
    actorId: overriddenBy,
  })

  return { success: true, overrideId: data.id }
}

/**
 * 检查某个实体是否有活跃的覆盖（某条规则被跳过）
 */
export async function checkOverride(ruleId: string, entityId: string): Promise<boolean> {
  const supabase = createClient()
  const { data } = await supabase
    .from('manual_overrides')
    .select('id')
    .eq('rule_id', ruleId)
    .eq('entity_id', entityId)
    .eq('override_type', 'skip_rule')
    .order('created_at', { ascending: false })
    .limit(1)

  return (data?.length || 0) > 0
}

/**
 * 批量:一次取该规则下所有 skip_rule 覆盖的 entity_id 集合。
 * 审计#22:编排引擎原在实体循环里逐个 checkOverride → 规则×实体 N+1。改为循环前一次拉全、
 * 循环内用 Set.has() 命中,行为等价、查询从 N 次降到 1 次。
 */
export async function getSkipRuleEntityIds(ruleId: string): Promise<Set<string>> {
  const supabase = createClient()
  const { data } = await supabase
    .from('manual_overrides')
    .select('entity_id')
    .eq('rule_id', ruleId)
    .eq('override_type', 'skip_rule')
  return new Set((data || []).map(d => d.entity_id as string))
}

/**
 * 获取最近的覆盖记录
 */
export async function getRecentOverrides(limit = 20): Promise<ManualOverride[]> {
  const supabase = createClient()
  const { data } = await supabase
    .from('manual_overrides')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  return (data as ManualOverride[]) || []
}
