// ============================================================
// Trust Engine — 多维度信任评分 (15+ 实体类型)
// 扩展 dependency-resolver.ts 的信任系统
// ============================================================

import { createClient } from '@/lib/supabase/client'
import { recordTimelineEvent } from './timeline-engine'
import { freezeEntity } from './freeze-engine'
import type { TrustLevel } from '@/lib/document-engine/dependency-resolver'

// --------------- Types ---------------

export interface TrustDimension {
  name: string
  weight: number
}

export interface DimensionScore {
  dimension: string
  weight: number
  rawScore: number       // 0-100
  weightedScore: number  // rawScore * weight / 100
  evidence: string
}

export interface TrustScoreResult {
  subjectType: string
  subjectId: string
  totalScore: number
  trustLevel: TrustLevel
  previousLevel: TrustLevel | null
  dimensions: DimensionScore[]
  trend: 'improving' | 'declining' | 'stable'
  calculatedAt: string
}

export interface TrustProfile {
  subjectType: string
  subjectId: string
  currentScore: number
  currentLevel: TrustLevel
  trend: 'improving' | 'declining' | 'stable'
  dimensions: DimensionScore[]
  history: { date: string; score: number; level: string }[]
  totalEvents: number
  correctEvents: number
  rejectedEvents: number
  rollbackEvents: number
  lastDowngradeReason: string | null
  autoFreezeTriggered: boolean
}

export interface TrustDashboard {
  summary: {
    total: number
    byLevel: Record<TrustLevel, number>
    recentDowngrades: number
    recentUpgrades: number
    frozenCount: number
  }
  lowTrust: { subjectType: string; subjectId: string; score: number; level: TrustLevel; trend: string }[]
  recentChanges: { subjectType: string; subjectId: string; from: string; to: string; reason: string; changedAt: string }[]
}

// --------------- Trust dimensions by entity type ---------------

const TRUST_DIMENSIONS: Record<string, TrustDimension[]> = {
  customer: [
    { name: 'payment_history', weight: 40 },
    { name: 'order_reliability', weight: 20 },
    { name: 'communication', weight: 10 },
    { name: 'financial_stability', weight: 20 },
    { name: 'longevity', weight: 10 },
  ],
  supplier: [
    { name: 'delivery_reliability', weight: 35 },
    { name: 'quality_consistency', weight: 25 },
    { name: 'price_stability', weight: 15 },
    { name: 'communication', weight: 10 },
    { name: 'longevity', weight: 15 },
  ],
  template: [
    { name: 'accuracy_rate', weight: 50 },
    { name: 'error_frequency', weight: 30 },
    { name: 'rollback_rate', weight: 20 },
  ],
  action_type: [
    { name: 'success_rate', weight: 50 },
    { name: 'rejection_rate', weight: 30 },
    { name: 'rollback_rate', weight: 20 },
  ],
  order: [
    { name: 'payment_compliance', weight: 40 },
    { name: 'delivery_accuracy', weight: 30 },
    { name: 'profit_margin', weight: 20 },
    { name: 'documentation', weight: 10 },
  ],
  product: [
    { name: 'defect_rate', weight: 40 },
    { name: 'return_rate', weight: 30 },
    { name: 'margin_stability', weight: 20 },
    { name: 'demand_predictability', weight: 10 },
  ],
  invoice: [
    { name: 'accuracy', weight: 50 },
    { name: 'dispute_rate', weight: 30 },
    { name: 'timeliness', weight: 20 },
  ],
  payment: [
    { name: 'on_time_rate', weight: 50 },
    { name: 'match_accuracy', weight: 30 },
    { name: 'deduction_frequency', weight: 20 },
  ],
  shipment: [
    { name: 'on_time_delivery', weight: 40 },
    { name: 'documentation_accuracy', weight: 30 },
    { name: 'damage_rate', weight: 30 },
  ],
  warehouse: [
    { name: 'inventory_accuracy', weight: 40 },
    { name: 'fulfillment_speed', weight: 30 },
    { name: 'loss_rate', weight: 30 },
  ],
  currency: [
    { name: 'volatility', weight: 50 },
    { name: 'hedge_effectiveness', weight: 30 },
    { name: 'forecast_accuracy', weight: 20 },
  ],
  agent: [
    { name: 'action_success_rate', weight: 40 },
    { name: 'false_positive_rate', weight: 30 },
    { name: 'user_override_rate', weight: 30 },
  ],
  report: [
    { name: 'data_accuracy', weight: 50 },
    { name: 'timeliness', weight: 30 },
    { name: 'completeness', weight: 20 },
  ],
  document: [
    { name: 'extraction_accuracy', weight: 50 },
    { name: 'match_success_rate', weight: 30 },
    { name: 'manual_correction_rate', weight: 20 },
  ],
  workflow: [
    { name: 'completion_rate', weight: 40 },
    { name: 'error_rate', weight: 35 },
    { name: 'avg_duration_stability', weight: 25 },
  ],
}

// --------------- Score to trust level mapping ---------------

function scoreToLevel(score: number): TrustLevel {
  if (score >= 90) return 'T5'
  if (score >= 80) return 'T4'
  if (score >= 60) return 'T3'
  if (score >= 40) return 'T2'
  if (score >= 20) return 'T1'
  return 'T0'
}

function determineTrend(
  currentScore: number,
  history: { trust_score: number }[]
): 'improving' | 'declining' | 'stable' {
  if (history.length < 2) return 'stable'
  // Compare against average of last 3 entries
  const recent = history.slice(0, 3)
  const avgRecent = recent.reduce((s, h) => s + Number(h.trust_score), 0) / recent.length
  const diff = currentScore - avgRecent
  if (diff > 3) return 'improving'
  if (diff < -3) return 'declining'
  return 'stable'
}

// --------------- Compute dimension scores from DB data ---------------

async function computeDimensionScores(
  subjectType: string,
  subjectId: string,
  dimensions: TrustDimension[]
): Promise<DimensionScore[]> {
  const supabase = createClient()
  const results: DimensionScore[] = []

  // Fetch the trust score record for event-based dimensions
  const { data: trustRecord } = await supabase
    .from('automation_trust_scores')
    .select('*')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .maybeSingle()

  const totalEvents = trustRecord?.total_events ?? 0
  const correctEvents = trustRecord?.correct_events ?? 0
  const rejectedEvents = trustRecord?.rejected_events ?? 0
  const rollbackEvents = trustRecord?.rollback_events ?? 0
  const correctRate = totalEvents > 0 ? correctEvents / totalEvents : 0.5
  const rejectRate = totalEvents > 0 ? rejectedEvents / totalEvents : 0
  const rollbackRate = totalEvents > 0 ? rollbackEvents / totalEvents : 0

  // Fetch entity-specific data for richer scoring
  let entityData: Record<string, unknown> | null = null

  if (subjectType === 'customer') {
    const { data } = await supabase
      .from('customer_financial_profiles')
      .select('*')
      .eq('customer_name', subjectId)
      .maybeSingle()
    entityData = data as Record<string, unknown> | null
  } else if (subjectType === 'supplier') {
    const { data } = await supabase
      .from('supplier_financial_profiles')
      .select('*')
      .eq('supplier_name', subjectId)
      .maybeSingle()
    entityData = data as Record<string, unknown> | null
  }

  for (const dim of dimensions) {
    let rawScore = 50 // Default middle score
    let evidence = 'Default baseline score'

    switch (dim.name) {
      // --- Customer dimensions ---
      case 'payment_history': {
        if (entityData) {
          const avgDays = Number(entityData.avg_payment_days ?? 30)
          const overdueRate = Number(entityData.overdue_rate ?? 0)
          // Excellent: <=30 days, 0% overdue -> 100. Poor: >90 days, >50% overdue -> 0
          rawScore = Math.max(0, Math.min(100,
            100 - Math.max(0, avgDays - 30) * 1.2 - overdueRate * 80
          ))
          evidence = `Avg payment ${avgDays}d, overdue rate ${(overdueRate * 100).toFixed(0)}%`
        }
        break
      }
      case 'order_reliability': {
        if (entityData) {
          const deductions = Number(entityData.deduction_frequency ?? 0)
          const disputes = Number(entityData.invoice_dispute_frequency ?? 0)
          rawScore = Math.max(0, 100 - deductions * 15 - disputes * 20)
          evidence = `Deductions: ${deductions}, disputes: ${disputes}`
        }
        break
      }
      case 'financial_stability': {
        if (entityData) {
          const outstanding = Number(entityData.total_outstanding ?? 0)
          const creditLimit = Number(entityData.credit_limit ?? 1)
          const utilization = creditLimit > 0 ? outstanding / creditLimit : 0
          const badDebt = Number(entityData.bad_debt_score ?? 0)
          rawScore = Math.max(0, Math.min(100, 100 - utilization * 40 - badDebt * 0.6))
          evidence = `Credit utilization ${(utilization * 100).toFixed(0)}%, bad debt score ${badDebt}`
        }
        break
      }
      case 'longevity': {
        // Based on number of events as proxy for relationship length
        rawScore = Math.min(100, totalEvents * 5 + 30)
        evidence = `${totalEvents} total events recorded`
        break
      }
      case 'communication': {
        if (entityData) {
          const lateConf = Number(entityData.late_confirmation_frequency ?? 0)
          rawScore = Math.max(0, 100 - lateConf * 20)
          evidence = `Late confirmations: ${lateConf}`
        } else {
          rawScore = 50 + Math.round(correctRate * 30)
          evidence = `Interaction success rate ${(correctRate * 100).toFixed(0)}%`
        }
        break
      }

      // --- Supplier dimensions ---
      case 'delivery_reliability': {
        if (entityData) {
          const stopSupply = Number(entityData.historical_stop_supply_count ?? 0)
          const delayTolerance = Number(entityData.avg_delay_tolerance_days ?? 7)
          rawScore = Math.max(0, 100 - stopSupply * 25 - Math.max(0, delayTolerance - 7) * 3)
          evidence = `Stop-supply count: ${stopSupply}, delay tolerance: ${delayTolerance}d`
        }
        break
      }
      case 'quality_consistency': {
        rawScore = 50 + Math.round(correctRate * 40) - Math.round(rollbackRate * 50)
        evidence = `Correct rate ${(correctRate * 100).toFixed(0)}%, rollback rate ${(rollbackRate * 100).toFixed(0)}%`
        break
      }
      case 'price_stability': {
        if (entityData) {
          const urgency = Number(entityData.urgency_score ?? 50)
          rawScore = Math.max(0, 100 - urgency)
          evidence = `Urgency score: ${urgency}`
        }
        break
      }

      // --- Generic event-based dimensions ---
      case 'accuracy_rate':
      case 'success_rate':
      case 'action_success_rate':
      case 'data_accuracy':
      case 'extraction_accuracy': {
        rawScore = Math.round(correctRate * 100)
        evidence = `${correctEvents}/${totalEvents} correct (${(correctRate * 100).toFixed(0)}%)`
        break
      }
      case 'error_frequency':
      case 'error_rate':
      case 'false_positive_rate': {
        rawScore = Math.max(0, Math.round((1 - rejectRate) * 100))
        evidence = `Reject rate ${(rejectRate * 100).toFixed(0)}% (inverted for score)`
        break
      }
      case 'rollback_rate':
      case 'manual_correction_rate':
      case 'user_override_rate': {
        rawScore = Math.max(0, Math.round((1 - rollbackRate) * 100))
        evidence = `Rollback rate ${(rollbackRate * 100).toFixed(0)}% (inverted for score)`
        break
      }
      case 'rejection_rate': {
        rawScore = Math.max(0, Math.round((1 - rejectRate) * 100))
        evidence = `Rejection rate ${(rejectRate * 100).toFixed(0)}% (inverted)`
        break
      }
      case 'completion_rate':
      case 'match_success_rate': {
        rawScore = Math.round(correctRate * 100)
        evidence = `Success/completion rate ${(correctRate * 100).toFixed(0)}%`
        break
      }

      // --- Time/stability-based dimensions ---
      case 'on_time_rate':
      case 'on_time_delivery':
      case 'timeliness': {
        rawScore = Math.max(0, 80 - Math.round(rejectRate * 60) + Math.round(correctRate * 20))
        evidence = `Estimated on-time metric from event data`
        break
      }
      case 'match_accuracy':
      case 'documentation_accuracy':
      case 'documentation':
      case 'accuracy': {
        rawScore = 50 + Math.round(correctRate * 40) - Math.round(rejectRate * 30)
        evidence = `Accuracy from correct/reject ratios`
        break
      }
      case 'payment_compliance': {
        if (entityData) {
          const overdueRate = Number(entityData.overdue_rate ?? 0)
          rawScore = Math.max(0, Math.round((1 - overdueRate) * 100))
          evidence = `Payment compliance ${rawScore}%`
        }
        break
      }
      case 'delivery_accuracy':
      case 'fulfillment_speed': {
        rawScore = 50 + Math.round(correctRate * 30)
        evidence = `Estimated from event success rate`
        break
      }
      case 'profit_margin':
      case 'margin_stability': {
        if (entityData) {
          const profitRate = Number(entityData.average_order_profit_rate ?? 10)
          rawScore = Math.min(100, Math.max(0, profitRate * 3 + 40))
          evidence = `Avg profit rate ${profitRate}%`
        }
        break
      }
      case 'deduction_frequency': {
        if (entityData) {
          const freq = Number(entityData.deduction_frequency ?? 0)
          rawScore = Math.max(0, 100 - freq * 20)
          evidence = `Deduction frequency: ${freq}`
        }
        break
      }
      case 'defect_rate':
      case 'return_rate':
      case 'damage_rate':
      case 'loss_rate': {
        rawScore = Math.max(0, Math.round((1 - rollbackRate) * 100))
        evidence = `Negative event rate inverted`
        break
      }
      case 'demand_predictability':
      case 'avg_duration_stability':
      case 'forecast_accuracy':
      case 'inventory_accuracy':
      case 'completeness': {
        rawScore = 50 + Math.round(correctRate * 30) - Math.round(rollbackRate * 20)
        evidence = `Stability metric from event ratios`
        break
      }
      case 'dispute_rate': {
        rawScore = Math.max(0, Math.round((1 - rejectRate) * 100))
        evidence = `Dispute rate ${(rejectRate * 100).toFixed(0)}% (inverted)`
        break
      }
      case 'volatility': {
        // For currency: lower volatility = higher trust
        rawScore = 50 + Math.round(correctRate * 30)
        evidence = `Stability estimate from hedge/forecast events`
        break
      }
      case 'hedge_effectiveness': {
        rawScore = 50 + Math.round(correctRate * 40)
        evidence = `Hedge success rate ${(correctRate * 100).toFixed(0)}%`
        break
      }

      default:
        rawScore = 50
        evidence = `No specific scoring logic for "${dim.name}"`
    }

    rawScore = Math.max(0, Math.min(100, rawScore))

    results.push({
      dimension: dim.name,
      weight: dim.weight,
      rawScore,
      weightedScore: (rawScore * dim.weight) / 100,
      evidence,
    })
  }

  return results
}

// --------------- Calculate trust score ---------------

export async function calculateTrustScore(
  subjectType: string,
  subjectId: string
): Promise<TrustScoreResult> {
  const supabase = createClient()
  const dimensions = TRUST_DIMENSIONS[subjectType] ?? TRUST_DIMENSIONS['action_type']

  // Get current record for previous level
  const { data: currentRecord } = await supabase
    .from('automation_trust_scores')
    .select('trust_level, trust_score')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .maybeSingle()

  const previousLevel = (currentRecord?.trust_level as TrustLevel) ?? null

  // Compute dimension scores
  const dimensionScores = await computeDimensionScores(subjectType, subjectId, dimensions)

  // Calculate total weighted score
  const totalScore = Math.round(
    dimensionScores.reduce((sum, d) => sum + d.weightedScore, 0)
  )
  const trustLevel = scoreToLevel(totalScore)

  // Get history for trend
  const { data: historyData } = await supabase
    .from('trust_score_history')
    .select('trust_score')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .order('snapshot_date', { ascending: false })
    .limit(5)

  const trend = determineTrend(totalScore, historyData ?? [])

  // Persist to automation_trust_scores
  const breakdown = Object.fromEntries(
    dimensionScores.map(d => [d.dimension, { raw: d.rawScore, weighted: d.weightedScore, evidence: d.evidence }])
  )

  const trendChanged = previousLevel && previousLevel !== trustLevel
  const downgradeReason = trendChanged && scoreToLevel(totalScore) < (previousLevel ?? 'T2')
    ? `Score dropped to ${totalScore} (${trustLevel})`
    : undefined

  await supabase.from('automation_trust_scores').upsert({
    subject_type: subjectType,
    subject_id: subjectId,
    trust_score: totalScore,
    trust_level: trustLevel,
    total_events: currentRecord ? undefined : 0,
    correct_events: currentRecord ? undefined : 0,
    rejected_events: currentRecord ? undefined : 0,
    rollback_events: currentRecord ? undefined : 0,
    score_breakdown: breakdown,
    trend,
    last_downgrade_reason: downgradeReason ?? (currentRecord as Record<string, unknown> | null)?.last_downgrade_reason ?? null,
    auto_freeze_triggered: trustLevel === 'T0' || trustLevel === 'T1',
    last_calculated_at: new Date().toISOString(),
  }, { onConflict: 'subject_type,subject_id' })

  // Auto-freeze on T0/T1
  if ((trustLevel === 'T0' || trustLevel === 'T1') && previousLevel && previousLevel !== 'T0' && previousLevel !== 'T1') {
    await freezeEntity({
      entityType: subjectType,
      entityId: subjectId,
      entityName: `${subjectType}:${subjectId}`,
      reason: `Trust score dropped to ${trustLevel} (${totalScore}/100). Auto-freeze triggered.`,
      freezeType: 'auto_trust',
      triggerSource: 'trust-engine',
    })
  }

  // Record timeline if level changed
  if (trendChanged) {
    await recordTimelineEvent({
      entityType: subjectType,
      entityId: subjectId,
      eventType: 'trust_level_changed',
      eventTitle: `信任等级变更: ${previousLevel} -> ${trustLevel}`,
      eventDetail: {
        previous_level: previousLevel,
        new_level: trustLevel,
        score: totalScore,
        breakdown,
        trend,
      },
      sourceType: 'system',
      actorName: 'trust-engine',
    })
  }

  return {
    subjectType,
    subjectId,
    totalScore,
    trustLevel,
    previousLevel,
    dimensions: dimensionScores,
    trend,
    calculatedAt: new Date().toISOString(),
  }
}

// --------------- Recalculate all trust scores ---------------

export async function recalculateAllTrustScores(): Promise<{
  updated: number
  downgrades: number
  upgrades: number
}> {
  const supabase = createClient()

  const { data: allSubjects } = await supabase
    .from('automation_trust_scores')
    .select('subject_type, subject_id, trust_level')

  if (!allSubjects || allSubjects.length === 0) {
    return { updated: 0, downgrades: 0, upgrades: 0 }
  }

  let updated = 0
  let downgrades = 0
  let upgrades = 0

  const LEVEL_ORDER: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4, T5: 5 }

  for (const subject of allSubjects) {
    const previousOrder = LEVEL_ORDER[subject.trust_level] ?? 2
    const result = await calculateTrustScore(subject.subject_type, subject.subject_id)
    const newOrder = LEVEL_ORDER[result.trustLevel] ?? 2

    updated++
    if (newOrder < previousOrder) downgrades++
    if (newOrder > previousOrder) upgrades++
  }

  return { updated, downgrades, upgrades }
}

// --------------- Get trust profile ---------------

export async function getTrustProfile(
  subjectType: string,
  subjectId: string
): Promise<TrustProfile> {
  const supabase = createClient()

  // Get current trust record
  const { data: record } = await supabase
    .from('automation_trust_scores')
    .select('*')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .maybeSingle()

  // Get history
  const { data: historyData } = await supabase
    .from('trust_score_history')
    .select('snapshot_date, trust_score, trust_level')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .order('snapshot_date', { ascending: false })
    .limit(30)

  const history = (historyData ?? []).map(h => ({
    date: h.snapshot_date,
    score: Number(h.trust_score),
    level: h.trust_level,
  }))

  // Compute fresh dimensions
  const dimensions = TRUST_DIMENSIONS[subjectType] ?? TRUST_DIMENSIONS['action_type']
  const dimensionScores = await computeDimensionScores(subjectType, subjectId, dimensions)

  const currentScore = record?.trust_score ?? 50
  const currentLevel = (record?.trust_level as TrustLevel) ?? 'T2'

  return {
    subjectType,
    subjectId,
    currentScore,
    currentLevel,
    trend: (record?.trend as 'improving' | 'declining' | 'stable') ?? 'stable',
    dimensions: dimensionScores,
    history,
    totalEvents: record?.total_events ?? 0,
    correctEvents: record?.correct_events ?? 0,
    rejectedEvents: record?.rejected_events ?? 0,
    rollbackEvents: record?.rollback_events ?? 0,
    lastDowngradeReason: record?.last_downgrade_reason ?? null,
    autoFreezeTriggered: record?.auto_freeze_triggered ?? false,
  }
}

// --------------- Downgrade trust ---------------

export async function downgradeTrust(
  subjectType: string,
  subjectId: string,
  reason: string,
  triggerFreeze: boolean = false
): Promise<void> {
  const supabase = createClient()

  // Get current record
  const { data: current } = await supabase
    .from('automation_trust_scores')
    .select('*')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .maybeSingle()

  const currentScore = current?.trust_score ?? 50
  const previousLevel = (current?.trust_level as TrustLevel) ?? 'T2'

  // Reduce score by 15 points (min 0)
  const newScore = Math.max(0, currentScore - 15)
  const newLevel = scoreToLevel(newScore)

  await supabase.from('automation_trust_scores').upsert({
    subject_type: subjectType,
    subject_id: subjectId,
    trust_score: newScore,
    trust_level: newLevel,
    total_events: current?.total_events ?? 0,
    correct_events: current?.correct_events ?? 0,
    rejected_events: current?.rejected_events ?? 0,
    rollback_events: current?.rollback_events ?? 0,
    trend: 'declining',
    last_downgrade_reason: reason,
    auto_freeze_triggered: triggerFreeze || newLevel === 'T0' || newLevel === 'T1',
    last_calculated_at: new Date().toISOString(),
  }, { onConflict: 'subject_type,subject_id' })

  await recordTimelineEvent({
    entityType: subjectType,
    entityId: subjectId,
    eventType: 'trust_downgraded',
    eventTitle: `信任降级: ${previousLevel} -> ${newLevel} (${reason})`,
    eventDetail: {
      previous_score: currentScore,
      new_score: newScore,
      previous_level: previousLevel,
      new_level: newLevel,
      reason,
      trigger_freeze: triggerFreeze,
    },
    sourceType: 'system',
    actorName: 'trust-engine',
  })

  // Trigger freeze if requested or if dropped to T0/T1
  if (triggerFreeze || newLevel === 'T0' || newLevel === 'T1') {
    await freezeEntity({
      entityType: subjectType,
      entityId: subjectId,
      entityName: `${subjectType}:${subjectId}`,
      reason: `Trust downgraded to ${newLevel} (score: ${newScore}). Reason: ${reason}`,
      freezeType: 'auto_trust',
      triggerSource: 'trust-engine/downgradeTrust',
    })
  }
}

// --------------- Trust dashboard ---------------

export async function getTrustDashboard(): Promise<TrustDashboard> {
  const supabase = createClient()

  // Get all trust scores
  const { data: allScores } = await supabase
    .from('automation_trust_scores')
    .select('*')
    .order('trust_score', { ascending: true })

  const scores = allScores ?? []

  // Count by level
  const byLevel: Record<TrustLevel, number> = { T0: 0, T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 }
  for (const s of scores) {
    const level = s.trust_level as TrustLevel
    byLevel[level] = (byLevel[level] || 0) + 1
  }

  // Get recent changes from trust_score_history (last 7 days)
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { data: recentHistory } = await supabase
    .from('trust_score_history')
    .select('*')
    .gte('snapshot_date', sevenDaysAgo.toISOString().slice(0, 10))
    .order('created_at', { ascending: false })
    .limit(50)

  // Detect recent downgrades / upgrades by comparing consecutive snapshots
  let recentDowngrades = 0
  let recentUpgrades = 0
  const recentChanges: TrustDashboard['recentChanges'] = []

  const historyBySubject = new Map<string, typeof recentHistory>()
  for (const h of recentHistory ?? []) {
    const key = `${h.subject_type}:${h.subject_id}`
    if (!historyBySubject.has(key)) historyBySubject.set(key, [])
    historyBySubject.get(key)!.push(h)
  }

  const LEVEL_ORDER: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4, T5: 5 }

  for (const [, entries] of historyBySubject) {
    if (entries && entries.length >= 2) {
      const latest = entries[0]!
      const previous = entries[1]!
      const latestOrder = LEVEL_ORDER[latest.trust_level] ?? 2
      const prevOrder = LEVEL_ORDER[previous.trust_level] ?? 2
      if (latestOrder < prevOrder) {
        recentDowngrades++
        recentChanges.push({
          subjectType: latest.subject_type,
          subjectId: latest.subject_id,
          from: previous.trust_level,
          to: latest.trust_level,
          reason: latest.change_reason ?? 'Score declined',
          changedAt: latest.created_at,
        })
      } else if (latestOrder > prevOrder) {
        recentUpgrades++
        recentChanges.push({
          subjectType: latest.subject_type,
          subjectId: latest.subject_id,
          from: previous.trust_level,
          to: latest.trust_level,
          reason: latest.change_reason ?? 'Score improved',
          changedAt: latest.created_at,
        })
      }
    }
  }

  // Count active freezes
  const { count: frozenCount } = await supabase
    .from('entity_freezes')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'frozen')

  // Low trust entities
  const lowTrust = scores
    .filter(s => LEVEL_ORDER[s.trust_level] <= 1)
    .map(s => ({
      subjectType: s.subject_type,
      subjectId: s.subject_id,
      score: s.trust_score,
      level: s.trust_level as TrustLevel,
      trend: s.trend ?? 'stable',
    }))

  return {
    summary: {
      total: scores.length,
      byLevel,
      recentDowngrades,
      recentUpgrades,
      frozenCount: frozenCount ?? 0,
    },
    lowTrust,
    recentChanges,
  }
}

// --------------- Record daily snapshot ---------------

export async function recordTrustSnapshot(): Promise<void> {
  const supabase = createClient()
  const today = new Date().toISOString().slice(0, 10)

  // Get all current scores
  const { data: allScores } = await supabase
    .from('automation_trust_scores')
    .select('*')

  if (!allScores || allScores.length === 0) return

  // Check if snapshots already exist for today
  const { data: existing } = await supabase
    .from('trust_score_history')
    .select('id')
    .eq('snapshot_date', today)
    .limit(1)

  if (existing && existing.length > 0) {
    // Snapshots already recorded today, skip
    return
  }

  // Insert snapshot for each subject
  const snapshots = allScores.map(s => ({
    subject_type: s.subject_type,
    subject_id: s.subject_id,
    trust_level: s.trust_level,
    trust_score: s.trust_score,
    score_breakdown: s.score_breakdown ?? null,
    change_reason: s.last_downgrade_reason ?? null,
    snapshot_date: today,
  }))

  const { error } = await supabase.from('trust_score_history').insert(snapshots)

  if (error) {
    console.error('[trust-engine] recordTrustSnapshot failed:', error.message)
  }
}
