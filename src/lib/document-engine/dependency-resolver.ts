// ============================================================
// 动作依赖解析 + 拓扑排序 + 信任层查询
// ============================================================

import { createClient } from '@/lib/supabase/client'
import type { ActionConfig } from './action-registry'

export type TrustLevel = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5'

const TRUST_LEVEL_ORDER: Record<TrustLevel, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4, T5: 5 }

// --- 拓扑排序：确定执行顺序，检测循环依赖 ---
export function topologicalSort(configs: ActionConfig[]): {
  sorted: ActionConfig[]
  hasCycle: boolean
} {
  const graph = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  const configMap = new Map<string, ActionConfig>()

  for (const c of configs) {
    configMap.set(c.action_type, c)
    graph.set(c.action_type, [])
    inDegree.set(c.action_type, 0)
  }

  for (const c of configs) {
    for (const dep of c.depends_on) {
      if (configMap.has(dep)) {
        graph.get(dep)!.push(c.action_type)
        inDegree.set(c.action_type, (inDegree.get(c.action_type) || 0) + 1)
      }
    }
  }

  const queue: string[] = []
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key)
  }

  const sorted: ActionConfig[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    sorted.push(configMap.get(node)!)

    for (const neighbor of graph.get(node) || []) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  return { sorted, hasCycle: sorted.length < configs.length }
}

// --- 检查依赖是否满足 ---
export function checkDependencies(
  config: ActionConfig,
  executedActions: Map<string, 'success' | 'failed' | 'skipped'>
): { satisfied: boolean; blockedBy: string | null; reason: string } {
  for (const dep of config.depends_on) {
    const depStatus = executedActions.get(dep)

    if (!depStatus || depStatus === 'skipped') {
      if (config.dependency_type === 'hard') {
        return { satisfied: false, blockedBy: dep, reason: `硬依赖 ${dep} 未执行` }
      }
      // soft dependency: 可继续
    }

    if (depStatus === 'failed') {
      if (config.dependency_type === 'hard') {
        return { satisfied: false, blockedBy: dep, reason: `硬依赖 ${dep} 执行失败` }
      }
    }
  }

  return { satisfied: true, blockedBy: null, reason: '依赖满足' }
}

// --- 查询信任分值 ---
export async function getTrustLevel(
  subjectType: 'customer' | 'supplier' | 'template' | 'action_type',
  subjectId: string
): Promise<{ trustLevel: TrustLevel; trustScore: number }> {
  try {
    const supabase = createClient()
    const { data } = await supabase
      .from('automation_trust_scores')
      .select('trust_level, trust_score')
      .eq('subject_type', subjectType)
      .eq('subject_id', subjectId)
      .single()

    if (data) {
      return { trustLevel: data.trust_level as TrustLevel, trustScore: data.trust_score }
    }
  } catch { /* 默认T2 */ }

  return { trustLevel: 'T2', trustScore: 50 }
}

// --- 更新信任分值 ---
export async function updateTrustScore(
  subjectType: string,
  subjectId: string,
  event: 'correct' | 'rejected' | 'rollback'
): Promise<void> {
  try {
    const supabase = createClient()

    // 获取当前分值
    const { data: current } = await supabase
      .from('automation_trust_scores')
      .select('*')
      .eq('subject_type', subjectType)
      .eq('subject_id', subjectId)
      .single()

    let total = (current?.total_events || 0) + 1
    let correct = current?.correct_events || 0
    let rejected = current?.rejected_events || 0
    let rollback = current?.rollback_events || 0

    if (event === 'correct') correct++
    if (event === 'rejected') rejected++
    if (event === 'rollback') rollback++

    // 计算分值: base 50 + correct率加分 - reject率扣分 - rollback重扣
    const correctRate = total > 0 ? correct / total : 0
    const rejectRate = total > 0 ? rejected / total : 0
    let score = 50 + Math.round(correctRate * 30) - Math.round(rejectRate * 20) - rollback * 10
    score = Math.max(0, Math.min(100, score))

    // 映射等级
    let level: TrustLevel = 'T2'
    if (score >= 90) level = 'T5'
    else if (score >= 80) level = 'T4'
    else if (score >= 60) level = 'T3'
    else if (score >= 40) level = 'T2'
    else if (score >= 20) level = 'T1'
    else level = 'T0'

    await supabase.from('automation_trust_scores').upsert({
      subject_type: subjectType,
      subject_id: subjectId,
      trust_score: score,
      trust_level: level,
      total_events: total,
      correct_events: correct,
      rejected_events: rejected,
      rollback_events: rollback,
      last_calculated_at: new Date().toISOString(),
    }, { onConflict: 'subject_type,subject_id' })
  } catch { /* best effort */ }
}

// --- 判断动作是否可根据信任等级自动执行 ---
export function canAutoExecuteByTrust(
  trustLevel: TrustLevel,
  safetyLevel: string
): boolean {
  const trustOrder = TRUST_LEVEL_ORDER[trustLevel] || 2
  const safetyOrder: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 }
  const safety = safetyOrder[safetyLevel] || 2

  // T3: L1/L2自动执行
  if (trustOrder >= 3 && safety <= 2) return true
  // T4: L1/L2/L3（非金额相关）自动推审批
  if (trustOrder >= 4 && safety <= 2) return true
  // T5: 大幅减少确认（但L3/L4仍需审批）
  if (trustOrder >= 5 && safety <= 2) return true

  return false
}
