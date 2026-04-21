// ============================================================
// Orchestration Engine — 自动化规则评估 + 任务管理
// 核心调度引擎：评估规则条件 → 执行动作 → 创建/管理任务
// 只调用已有引擎，不写新查询逻辑
// ============================================================

import { createClient } from '@/lib/supabase/client'
import { safeRate } from '@/lib/accounting/utils'
import { recordTimelineEvent } from './timeline-engine'
import { freezeEntity, isEntityFrozen } from './freeze-engine'
import { downgradeTrust, getTrustDashboard } from './trust-engine'
import { getAuditFindings } from './audit-engine'
import { getActiveFreezes } from './freeze-engine'
import { getClosingStatus } from './closing-engine'
import { getBudgetOrders, getPendingRiskEvents } from '@/lib/supabase/queries'
import { checkOverride } from './override-engine'

// --------------- Types ---------------

interface TriggeredEntity {
  type: string
  id: string
  name: string
  detail: Record<string, unknown>
}

interface ConditionResult {
  triggered: boolean
  entities: TriggeredEntity[]
}

interface OrchestrationResult {
  rulesEvaluated: number
  rulesTriggered: number
  tasksCreated: number
  actionsExecuted: string[]
}

// --------------- Run All Rules ---------------

export async function runOrchestration(options?: {
  dryRun?: boolean
  executionId?: string
  actor?: 'system' | 'user' | 'cron'
}): Promise<OrchestrationResult> {
  const supabase = createClient()
  const executionId = options?.executionId || `exec-${Date.now()}`
  const isDryRun = options?.dryRun || false
  const actor = options?.actor || 'system'

  // Load all enabled, non-draft rules
  const { data: rules, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('is_enabled', true)
    .order('priority', { ascending: true })

  // 过滤草稿规则（灰度上线前）
  const activeRules = (rules || []).filter(r => !(r.is_draft as boolean))

  if (error || activeRules.length === 0) {
    return { rulesEvaluated: 0, rulesTriggered: 0, tasksCreated: 0, actionsExecuted: [] }
  }

  const result: OrchestrationResult = { rulesEvaluated: 0, rulesTriggered: 0, tasksCreated: 0, actionsExecuted: [] }
  const now = Date.now()
  const executedThisRun: { entityId: string; actionType: string; ruleId: string }[] = []

  for (const rule of activeRules) {
    const ruleStart = Date.now()
    const ruleName = rule.name as string
    const ruleId = rule.id as string

    // === Cooldown检查 ===
    if (rule.cooldown_minutes && rule.last_triggered_at) {
      const cooldownMs = (rule.cooldown_minutes as number) * 60 * 1000
      if (now - new Date(rule.last_triggered_at as string).getTime() < cooldownMs) {
        await writeExecutionLog(supabase, { ruleId, ruleName, executionId, actor, environment: isDryRun ? 'dry_run' : 'live', conditionResult: { triggered: false, reason: 'cooldown' }, entitiesMatched: [], actionsTaken: [], result: 'skipped', explanation: `冷却期内(${rule.cooldown_minutes}分钟)`, durationMs: Date.now() - ruleStart })
        continue
      }
    }

    result.rulesEvaluated++

    try {
      // === 条件评估 ===
      const conditionResult = await evaluateCondition(
        rule.condition_type as string,
        (rule.condition_config as Record<string, unknown>) || {}
      )

      if (!conditionResult.triggered || conditionResult.entities.length === 0) {
        await writeExecutionLog(supabase, { ruleId, ruleName, executionId, actor, environment: isDryRun ? 'dry_run' : 'live', conditionResult: { triggered: false, entityCount: 0 }, entitiesMatched: [], actionsTaken: [], result: 'skipped', explanation: '条件未满足', durationMs: Date.now() - ruleStart })
        continue
      }

      result.rulesTriggered++
      const actionsTaken: { action_type: string; entity_id: string; result: string; error?: string }[] = []

      for (const entity of conditionResult.entities) {
        try {
          // === 覆盖检查 ===
          const isOverridden = await checkOverride(ruleId, entity.id)
          if (isOverridden) {
            actionsTaken.push({ action_type: rule.action_type as string, entity_id: entity.id, result: 'overridden' })
            continue
          }

          // === 冲突检测 ===
          const conflict = detectConflict(rule.action_type as string, entity, executedThisRun)
          if (conflict.hasConflict) {
            actionsTaken.push({ action_type: rule.action_type as string, entity_id: entity.id, result: 'conflict', error: conflict.explanation })
            continue
          }

          // === 灰度检查 ===
          if (rule.grayscale_config) {
            const gc = rule.grayscale_config as Record<string, unknown>
            const scopeIds = gc.ids as string[] | undefined
            if (scopeIds && scopeIds.length > 0 && !scopeIds.includes(entity.id)) {
              actionsTaken.push({ action_type: rule.action_type as string, entity_id: entity.id, result: 'skipped', error: '不在灰度范围内' })
              continue
            }
          }

          // === Dry-run模式 ===
          if (isDryRun) {
            actionsTaken.push({ action_type: rule.action_type as string, entity_id: entity.id, result: 'dry_run' })
            result.actionsExecuted.push(`[DRY] ${ruleName}: ${rule.action_type} on ${entity.type}:${entity.id}`)
          } else {
            // === 实际执行 ===
            await executeRuleAction(rule.action_type as string, (rule.action_config as Record<string, unknown>) || {}, entity, ruleId)
            actionsTaken.push({ action_type: rule.action_type as string, entity_id: entity.id, result: 'success' })
            executedThisRun.push({ entityId: entity.id, actionType: rule.action_type as string, ruleId })
            result.actionsExecuted.push(`${ruleName}: ${rule.action_type} on ${entity.type}:${entity.id}`)
            if (rule.action_type === 'create_task') result.tasksCreated++
          }
        } catch (actionErr) {
          const errMsg = actionErr instanceof Error ? actionErr.message : String(actionErr)
          actionsTaken.push({ action_type: rule.action_type as string, entity_id: entity.id, result: 'failed', error: errMsg })
          console.error(`[orchestration] Action failed: "${ruleName}" ${entity.id}:`, errMsg)
        }
      }

      // === 写执行日志 ===
      const successCount = actionsTaken.filter(a => a.result === 'success' || a.result === 'dry_run').length
      const failCount = actionsTaken.filter(a => a.result === 'failed').length
      const logResult = isDryRun ? 'dry_run' : failCount === actionsTaken.length ? 'failed' : failCount > 0 ? 'partial' : 'success'

      await writeExecutionLog(supabase, {
        ruleId, ruleName, executionId, actor,
        environment: isDryRun ? 'dry_run' : 'live',
        conditionResult: { triggered: true, entityCount: conditionResult.entities.length },
        entitiesMatched: conditionResult.entities.map(e => ({ type: e.type, id: e.id, name: e.name })),
        actionsTaken,
        result: logResult,
        explanation: `${successCount}成功 ${failCount}失败 ${actionsTaken.filter(a => a.result === 'overridden').length}被覆盖 ${actionsTaken.filter(a => a.result === 'conflict').length}冲突`,
        durationMs: Date.now() - ruleStart,
      })

      // 更新规则触发记录
      if (!isDryRun && successCount > 0) {
        await supabase.from('automation_rules').update({
          last_triggered_at: new Date().toISOString(),
          trigger_count: ((rule.trigger_count as number) || 0) + 1,
        }).eq('id', ruleId)
      }
    } catch (evalErr) {
      const errMsg = evalErr instanceof Error ? evalErr.message : String(evalErr)
      await writeExecutionLog(supabase, { ruleId, ruleName, executionId, actor, environment: isDryRun ? 'dry_run' : 'live', conditionResult: { triggered: false, error: errMsg }, entitiesMatched: [], actionsTaken: [], result: 'failed', explanation: `条件评估失败: ${errMsg}`, durationMs: Date.now() - ruleStart })
      console.error(`[orchestration] Eval failed: "${ruleName}":`, errMsg)
    }
  }

  return result
}

// === 执行日志写入 ===
async function writeExecutionLog(supabase: ReturnType<typeof createClient>, log: {
  ruleId: string; ruleName: string; executionId: string; actor: string; environment: string;
  conditionResult: Record<string, unknown>; entitiesMatched: Record<string, unknown>[];
  actionsTaken: Record<string, unknown>[]; result: string; explanation: string; durationMs: number;
}) {
  await supabase.from('rule_execution_logs').insert({
    rule_id: log.ruleId, rule_name: log.ruleName, execution_id: log.executionId,
    actor: log.actor, environment: log.environment,
    condition_result: log.conditionResult, entities_matched: log.entitiesMatched,
    actions_taken: log.actionsTaken, result: log.result,
    explanation: log.explanation, duration_ms: log.durationMs,
  }).then(({ error }) => { if (error) console.error('[exec-log] write failed:', error.message) })
}

// === 冲突检测 ===
function detectConflict(
  actionType: string,
  entity: TriggeredEntity,
  executedThisRun: { entityId: string; actionType: string; ruleId: string }[]
): { hasConflict: boolean; conflictType?: string; explanation?: string } {
  const sameEntity = executedThisRun.filter(e => e.entityId === entity.id)
  if (sameEntity.length === 0) return { hasConflict: false }

  // freeze + 任何其他动作 = 冲突
  if (actionType === 'freeze_entity' && sameEntity.some(e => e.actionType !== 'freeze_entity')) {
    return { hasConflict: true, conflictType: 'freeze_vs_action', explanation: `同一实体${entity.name}本批次已有其他动作执行` }
  }
  // 重复freeze = 跳过
  if (actionType === 'freeze_entity' && sameEntity.some(e => e.actionType === 'freeze_entity')) {
    return { hasConflict: true, conflictType: 'duplicate_freeze', explanation: `${entity.name}已在本批次被冻结` }
  }
  // downgrade + upgrade同批次 = 冲突
  if (actionType === 'downgrade_trust' && sameEntity.some(e => e.actionType === 'upgrade_trust')) {
    return { hasConflict: true, conflictType: 'trust_conflict', explanation: `${entity.name}本批次已有信任升级，不能同时降级` }
  }

  return { hasConflict: false }
}

// === 自动化健康度 ===
export async function getAutomationHealth(): Promise<{
  score: number; successRate: number; conflictRate: number; overrideRate: number;
  dryRunPending: number; totalExecutions: number;
  riskiestRules: { ruleId: string; name: string; failRate: number }[];
  trend: 'improving' | 'stable' | 'declining'
}> {
  const supabase = createClient()

  // 最近7天的执行日志
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: logs } = await supabase
    .from('rule_execution_logs')
    .select('rule_id, rule_name, result')
    .gte('trigger_time', weekAgo)

  if (!logs?.length) return { score: 100, successRate: 100, conflictRate: 0, overrideRate: 0, dryRunPending: 0, totalExecutions: 0, riskiestRules: [], trend: 'stable' }

  const total = logs.length
  const success = logs.filter(l => l.result === 'success' || l.result === 'dry_run').length
  const conflicts = logs.filter(l => l.result === 'conflict').length
  const overrides = logs.filter(l => l.result === 'overridden').length
  const failures = logs.filter(l => l.result === 'failed').length

  const successRate = Math.round(success / total * 100)
  const conflictRate = Math.round(conflicts / total * 100)
  const overrideRate = Math.round(overrides / total * 100)

  // 高风险规则（失败率最高）
  const ruleStats = new Map<string, { name: string; total: number; failed: number }>()
  logs.forEach(l => {
    const key = l.rule_id as string
    if (!ruleStats.has(key)) ruleStats.set(key, { name: l.rule_name as string, total: 0, failed: 0 })
    const s = ruleStats.get(key)!
    s.total++
    if (l.result === 'failed') s.failed++
  })
  const riskiestRules = Array.from(ruleStats.entries())
    .map(([ruleId, s]) => ({ ruleId, name: s.name, failRate: s.total > 0 ? Math.round(s.failed / s.total * 100) : 0 }))
    .filter(r => r.failRate > 0)
    .sort((a, b) => b.failRate - a.failRate)
    .slice(0, 5)

  // 草稿规则数
  const { count: draftCount } = await supabase.from('automation_rules').select('id', { count: 'exact', head: true }).eq('is_draft', true)

  const score = Math.max(0, Math.min(100, 100 - failures * 3 - conflicts * 2 - overrides))

  return {
    score, successRate, conflictRate, overrideRate,
    dryRunPending: draftCount || 0, totalExecutions: total,
    riskiestRules,
    trend: score >= 80 ? 'improving' : score >= 50 ? 'stable' : 'declining',
  }
}

// --------------- Condition Evaluators ---------------

async function evaluateCondition(
  conditionType: string,
  config: Record<string, unknown>
): Promise<ConditionResult> {
  switch (conditionType) {
    case 'trust_low':
      return evaluateTrustLow(config)
    case 'margin_low':
      return evaluateMarginLow(config)
    case 'overdue_ar':
      return evaluateOverdueAR(config)
    case 'blocked_timeout':
      return evaluateBlockedTimeout(config)
    case 'rollback_high':
      return evaluateRollbackHigh(config)
    case 'audit_critical':
      return evaluateAuditCritical()
    case 'closing_incomplete':
      return evaluateClosingIncomplete(config)
    case 'cashflow_gap':
      return evaluateCashflowGap(config)
    case 'task_overdue':
      return evaluateTaskOverdue()
    case 'duplicate_payment':
      return evaluateDuplicatePayment()
    case 'supplier_risk':
      return evaluateSupplierRisk(config)
    case 'ocr_low_confidence':
      return evaluateOcrLowConfidence(config)
    default:
      console.warn(`[orchestration] Unknown condition type: ${conditionType}`)
      return { triggered: false, entities: [] }
  }
}

// 1. trust_low — 信任等级低于阈值
async function evaluateTrustLow(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const thresholdLevel = (config.threshold_level as string) || 'T1'

  const levelOrder: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4, T5: 5 }
  const thresholdOrder = levelOrder[thresholdLevel] ?? 1

  const { data: scores } = await supabase
    .from('automation_trust_scores')
    .select('subject_type, subject_id, trust_level, trust_score')

  if (!scores?.length) return { triggered: false, entities: [] }

  const entities: TriggeredEntity[] = scores
    .filter((s) => (levelOrder[s.trust_level as string] ?? 5) <= thresholdOrder)
    .map((s) => ({
      type: s.subject_type as string,
      id: s.subject_id as string,
      name: `${s.subject_type}:${s.subject_id}`,
      detail: {
        trust_level: s.trust_level,
        trust_score: s.trust_score,
        entity_name: `${s.subject_type}:${s.subject_id}`,
      },
    }))

  return { triggered: entities.length > 0, entities }
}

// 2. margin_low — 订单毛利率低于阈值
async function evaluateMarginLow(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const threshold = (config.threshold as number) ?? 10

  const { data: orders } = await supabase
    .from('budget_orders')
    .select('id, order_no, customer_id, estimated_margin, estimated_profit, total_revenue, total_cost, status')
    .in('status', ['approved', 'closed'])
    .lt('estimated_margin', threshold)

  if (!orders?.length) return { triggered: false, entities: [] }

  // Load customer names
  const customerIdSet: Record<string, boolean> = {}
  orders.forEach((o) => { if (o.customer_id) customerIdSet[o.customer_id as string] = true })
  const customerIds = Object.keys(customerIdSet)
  const { data: customers } = await supabase
    .from('customers')
    .select('id, company')
    .in('id', customerIds)

  const customerMap: Record<string, string> = {}
  for (const c of customers || []) {
    customerMap[c.id as string] = c.company as string
  }

  const entities: TriggeredEntity[] = orders.map((o) => ({
    type: 'budget_order',
    id: o.id as string,
    name: o.order_no as string,
    detail: {
      order_no: o.order_no,
      margin: o.estimated_margin,
      profit: o.estimated_profit,
      revenue: o.total_revenue,
      cost: o.total_cost,
      customer: customerMap[o.customer_id as string] || '未知客户',
    },
  }))

  return { triggered: entities.length > 0, entities }
}

// 3. overdue_ar — 应收账款超期
async function evaluateOverdueAR(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const thresholdDays = (config.threshold_days as number) ?? 30

  // Approved orders not yet closed, check days since delivery_date + 30 (payment term)
  const { data: orders } = await supabase
    .from('budget_orders')
    .select('id, order_no, customer_id, delivery_date, order_date, total_revenue, currency, exchange_rate, status')
    .eq('status', 'approved')
    .not('delivery_date', 'is', null)

  if (!orders?.length) return { triggered: false, entities: [] }

  const now = Date.now()
  const customerIdSet: Record<string, boolean> = {}
  orders.forEach((o) => { if (o.customer_id) customerIdSet[o.customer_id as string] = true })
  const customerIds = Object.keys(customerIdSet)
  const { data: customers } = await supabase
    .from('customers')
    .select('id, company')
    .in('id', customerIds)

  const customerMap: Record<string, string> = {}
  for (const c of customers || []) {
    customerMap[c.id as string] = c.company as string
  }

  const entities: TriggeredEntity[] = []

  for (const o of orders) {
    const baseDate = o.delivery_date || o.order_date
    if (!baseDate) continue

    const dueDate = new Date(baseDate as string)
    dueDate.setDate(dueDate.getDate() + 30) // 30-day payment term
    const overdueDays = Math.floor((now - dueDate.getTime()) / (1000 * 60 * 60 * 24))

    if (overdueDays >= thresholdDays) {
      const rate = safeRate(o.exchange_rate as number, o.currency as string, `orchestration order ${o.id}`)
      const amountCny = (o.total_revenue as number) * rate

      entities.push({
        type: 'budget_order',
        id: o.id as string,
        name: o.order_no as string,
        detail: {
          order_no: o.order_no,
          customer: customerMap[o.customer_id as string] || '未知客户',
          overdue_days: overdueDays,
          amount: o.total_revenue,
          amount_cny: Math.round(amountCny),
          delivery_date: o.delivery_date,
        },
      })
    }
  }

  return { triggered: entities.length > 0, entities }
}

// 4. blocked_timeout — 动作阻塞超时
async function evaluateBlockedTimeout(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const thresholdHours = (config.threshold_hours as number) ?? 48

  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000).toISOString()

  const { data: actions } = await supabase
    .from('document_actions')
    .select('id, action_type, decision, created_at, uploaded_documents(file_name, doc_category)')
    .eq('decision', 'pending')
    .lt('created_at', cutoff)

  if (!actions?.length) return { triggered: false, entities: [] }

  const entities: TriggeredEntity[] = actions.map((a) => {
    const doc = a.uploaded_documents as unknown as Record<string, unknown> | null
    const hoursBlocked = Math.round(
      (Date.now() - new Date(a.created_at as string).getTime()) / (1000 * 60 * 60)
    )
    return {
      type: 'document_action',
      id: a.id as string,
      name: (doc?.file_name as string) || `action:${a.id}`,
      detail: {
        action_type: a.action_type,
        hours: hoursBlocked,
        file_name: doc?.file_name || null,
        doc_category: doc?.doc_category || null,
      },
    }
  })

  return { triggered: entities.length > 0, entities }
}

// 5. rollback_high — 高频回滚
async function evaluateRollbackHigh(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const thresholdCount = (config.threshold_count as number) ?? 3
  const periodDays = (config.period_days as number) ?? 30

  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString()

  const { data: events } = await supabase
    .from('entity_timeline')
    .select('entity_type, entity_id')
    .eq('event_type', 'rollback')
    .gte('created_at', since)

  if (!events?.length) return { triggered: false, entities: [] }

  // Group by entity
  const counts = new Map<string, { type: string; id: string; count: number }>()
  for (const e of events) {
    const key = `${e.entity_type}:${e.entity_id}`
    const existing = counts.get(key)
    if (existing) {
      existing.count++
    } else {
      counts.set(key, { type: e.entity_type as string, id: e.entity_id as string, count: 1 })
    }
  }

  const entities: TriggeredEntity[] = []
  for (const [, v] of Array.from(counts)) {
    if (v.count > thresholdCount) {
      entities.push({
        type: v.type,
        id: v.id,
        name: `${v.type}:${v.id}`,
        detail: { rollback_count: v.count, period_days: periodDays },
      })
    }
  }

  return { triggered: entities.length > 0, entities }
}

// 6. audit_critical — 严重稽核发现
async function evaluateAuditCritical(): Promise<ConditionResult> {
  try {
    const findings = await getAuditFindings({ status: 'open', severity: 'critical' })

    const entities: TriggeredEntity[] = findings.map((f) => ({
      type: f.entityType,
      id: f.entityId || f.id,
      name: f.title,
      detail: {
        finding_id: f.id,
        finding_title: f.title,
        finding_type: f.findingType,
        description: f.description,
      },
    }))

    return { triggered: entities.length > 0, entities }
  } catch {
    return { triggered: false, entities: [] }
  }
}

// 7. closing_incomplete — 月结未完成
async function evaluateClosingIncomplete(config: Record<string, unknown>): Promise<ConditionResult> {
  const daysBeforeEnd = (config.days_before_end as number) ?? 3

  // Check if we're within N days of month end
  const now = new Date()
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysRemaining = lastDayOfMonth - now.getDate()

  if (daysRemaining > daysBeforeEnd) {
    return { triggered: false, entities: [] }
  }

  const periodCode = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  try {
    const items = await getClosingStatus(periodCode)
    if (items.length === 0) return { triggered: false, entities: [] }

    const pending = items.filter((i) => i.status === 'pending' || i.status === 'failed')
    if (pending.length === 0) return { triggered: false, entities: [] }

    return {
      triggered: true,
      entities: [
        {
          type: 'period_close',
          id: periodCode,
          name: periodCode,
          detail: {
            period: periodCode,
            pending: pending.length,
            total: items.length,
            pending_checks: pending.map((p) => p.checkLabel),
          },
        },
      ],
    }
  } catch {
    return { triggered: false, entities: [] }
  }
}

// 8. cashflow_gap — 现金流缺口
async function evaluateCashflowGap(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const threshold = (config.threshold as number) ?? -50000

  const { data: forecasts } = await supabase
    .from('cashflow_forecasts')
    .select('id, period_label, net_cashflow, warning_level, cumulative_balance')
    .in('warning_level', ['danger', 'critical'])

  if (!forecasts?.length) return { triggered: false, entities: [] }

  const entities: TriggeredEntity[] = forecasts
    .filter((f) => (f.net_cashflow as number) < threshold)
    .map((f) => ({
      type: 'cashflow_forecast',
      id: f.id as string,
      name: f.period_label as string,
      detail: {
        gap: f.net_cashflow,
        warning_level: f.warning_level,
        cumulative_balance: f.cumulative_balance,
        period_label: f.period_label,
      },
    }))

  return { triggered: entities.length > 0, entities }
}

// 9. task_overdue — 任务超期
async function evaluateTaskOverdue(): Promise<ConditionResult> {
  const supabase = createClient()
  const now = new Date().toISOString()

  const { data: tasks } = await supabase
    .from('orchestration_tasks')
    .select('id, title, severity, source_module, assignee_role, due_date, created_at')
    .eq('status', 'pending')
    .not('due_date', 'is', null)
    .lt('due_date', now)

  if (!tasks?.length) return { triggered: false, entities: [] }

  const entities: TriggeredEntity[] = tasks.map((t) => ({
    type: 'orchestration_task',
    id: t.id as string,
    name: t.title as string,
    detail: {
      task_id: t.id,
      title: t.title,
      severity: t.severity,
      source_module: t.source_module,
      assignee_role: t.assignee_role,
      due_date: t.due_date,
      overdue_hours: Math.round(
        (Date.now() - new Date(t.due_date as string).getTime()) / (1000 * 60 * 60)
      ),
    },
  }))

  return { triggered: entities.length > 0, entities }
}

// 10. duplicate_payment — 重复付款 (复用 audit-engine 的模式)
async function evaluateDuplicatePayment(): Promise<ConditionResult> {
  const supabase = createClient()

  const { data: payables } = await supabase
    .from('payable_records')
    .select('id, order_no, supplier_name, amount, currency, created_at, payment_status')
    .in('payment_status', ['paid', 'approved'])
    .order('created_at', { ascending: true })

  if (!payables?.length) return { triggered: false, entities: [] }

  const entities: TriggeredEntity[] = []
  const seenPairs = new Set<string>()

  for (let i = 0; i < payables.length; i++) {
    for (let j = i + 1; j < payables.length; j++) {
      const a = payables[i]
      const b = payables[j]

      if (
        a.supplier_name === b.supplier_name &&
        Math.abs((a.amount as number) - (b.amount as number)) < 0.01
      ) {
        const dayDiff =
          Math.abs(
            new Date(b.created_at as string).getTime() -
              new Date(a.created_at as string).getTime()
          ) / (1000 * 60 * 60 * 24)

        if (dayDiff <= 7) {
          const pairKey = [a.id, b.id].sort().join('-')
          if (seenPairs.has(pairKey)) continue
          seenPairs.add(pairKey)

          entities.push({
            type: 'supplier',
            id: a.supplier_name as string,
            name: a.supplier_name as string,
            detail: {
              supplier_name: a.supplier_name,
              amount: a.amount,
              currency: a.currency,
              record_a: a.id,
              record_b: b.id,
              days_between: Math.round(dayDiff),
            },
          })
        }
      }
    }
  }

  return { triggered: entities.length > 0, entities }
}

// 11. supplier_risk — 高风险供应商
async function evaluateSupplierRisk(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const thresholdLevel = (config.threshold_level as string) || 'D'

  const riskOrder: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5 }
  const thresholdOrder = riskOrder[thresholdLevel] ?? 4

  const { data: suppliers } = await supabase
    .from('supplier_financial_profiles')
    .select('id, supplier_name, risk_level, urgency_score, total_payable')

  if (!suppliers?.length) return { triggered: false, entities: [] }

  const entities: TriggeredEntity[] = suppliers
    .filter((s) => (riskOrder[s.risk_level as string] ?? 0) >= thresholdOrder)
    .map((s) => ({
      type: 'supplier',
      id: s.id as string,
      name: s.supplier_name as string,
      detail: {
        supplier_name: s.supplier_name,
        risk_level: s.risk_level,
        urgency_score: s.urgency_score,
        total_payable: s.total_payable,
      },
    }))

  return { triggered: entities.length > 0, entities }
}

// 12. ocr_low_confidence — OCR低置信度
async function evaluateOcrLowConfidence(config: Record<string, unknown>): Promise<ConditionResult> {
  const supabase = createClient()
  const threshold = (config.threshold as number) ?? 70

  const { data: docs } = await supabase
    .from('uploaded_documents')
    .select('id, file_name, doc_category, doc_category_confidence, created_at')
    .lt('doc_category_confidence', threshold)
    .not('doc_category_confidence', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50)

  if (!docs?.length) return { triggered: false, entities: [] }

  const entities: TriggeredEntity[] = docs.map((d) => ({
    type: 'uploaded_document',
    id: d.id as string,
    name: d.file_name as string,
    detail: {
      file_name: d.file_name,
      doc_category: d.doc_category,
      confidence: d.doc_category_confidence,
    },
  }))

  return { triggered: entities.length > 0, entities }
}

// --------------- Action Executors ---------------

async function executeRuleAction(
  actionType: string,
  actionConfig: Record<string, unknown>,
  entity: TriggeredEntity,
  ruleId: string
): Promise<void> {
  switch (actionType) {
    case 'create_task':
      await executeCreateTask(actionConfig, entity, ruleId)
      break
    case 'freeze_entity':
      await executeFreezeEntity(actionConfig, entity, ruleId)
      break
    case 'downgrade_trust':
      await executeDowngradeTrust(actionConfig, entity)
      break
    case 'escalate_task':
      await executeEscalateTask(entity)
      break
    default:
      console.warn(`[orchestration] Unknown action type: ${actionType}`)
  }
}

async function executeCreateTask(
  config: Record<string, unknown>,
  entity: TriggeredEntity,
  ruleId: string
): Promise<void> {
  const titleTemplate = (config.title_template as string) || '自动任务: {entity_name}'
  const severity = (config.severity as string) || 'warning'
  const assigneeRole = (config.assignee_role as string) || 'finance_staff'

  // Interpolate title template with entity detail
  const title = interpolateTemplate(titleTemplate, {
    ...entity.detail,
    entity_name: entity.name,
  })

  await createTask({
    title,
    severity,
    sourceModule: entity.type,
    sourceEntityType: entity.type,
    sourceEntityId: entity.id,
    explanation: `自动规则触发: ${title}`,
    assigneeRole,
    suggestedAction: (config.suggested_action as string) || undefined,
    actionHref: (config.action_href as string) || undefined,
    ruleId,
  })
}

async function executeFreezeEntity(
  config: Record<string, unknown>,
  entity: TriggeredEntity,
  ruleId: string
): Promise<void> {
  const freezeType = (config.freeze_type as string) || 'auto_audit'
  const reason = (config.reason as string) || '自动规则触发冻结'

  await freezeEntity({
    entityType: entity.type,
    entityId: entity.id,
    entityName: entity.name,
    reason,
    freezeType: freezeType as 'auto_breaker' | 'auto_audit' | 'auto_trust',
    triggerSource: `orchestration:rule:${ruleId}`,
  })
}

async function executeDowngradeTrust(
  config: Record<string, unknown>,
  entity: TriggeredEntity
): Promise<void> {
  const reason = (config.reason as string) || '自动规则触发信任降级'
  await downgradeTrust(entity.type, entity.id, reason)
}

async function executeEscalateTask(entity: TriggeredEntity): Promise<void> {
  const taskId = entity.detail.task_id as string || entity.id
  await escalateTask(taskId)
}

// --------------- Template Interpolation ---------------

function interpolateTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = data[key]
    if (value === null || value === undefined) return `{${key}}`
    return String(value)
  })
}

// --------------- Task CRUD ---------------

export async function createTask(params: {
  title: string
  severity: string
  sourceModule: string
  sourceEntityType?: string
  sourceEntityId?: string
  explanation: string
  assigneeRole?: string
  suggestedAction?: string
  actionHref?: string
  ruleId?: string
}): Promise<string> {
  const supabase = createClient()

  // Deduplication: check if similar task already exists
  if (params.sourceEntityId) {
    const { data: existing } = await supabase
      .from('orchestration_tasks')
      .select('id')
      .eq('source_module', params.sourceModule)
      .eq('source_entity_id', params.sourceEntityId)
      .not('status', 'in', '("resolved","closed","cancelled")')
      .limit(1)

    if (existing && existing.length > 0) {
      // Task already exists for this entity, skip
      return existing[0].id as string
    }
  }

  // Set due_date based on severity
  const dueDate = new Date()
  switch (params.severity) {
    case 'urgent':
      dueDate.setHours(dueDate.getHours() + 4)
      break
    case 'critical':
      dueDate.setHours(dueDate.getHours() + 24)
      break
    case 'warning':
      dueDate.setDate(dueDate.getDate() + 3)
      break
    default: // info
      dueDate.setDate(dueDate.getDate() + 7)
      break
  }

  const { data, error } = await supabase
    .from('orchestration_tasks')
    .insert({
      title: params.title,
      severity: params.severity,
      source_module: params.sourceModule,
      source_entity_type: params.sourceEntityType || null,
      source_entity_id: params.sourceEntityId || null,
      explanation: params.explanation,
      assignee_role: params.assigneeRole || 'finance_staff',
      due_date: dueDate.toISOString(),
      status: 'pending',
      created_by_rule: !!params.ruleId,
      rule_id: params.ruleId || null,
      suggested_action: params.suggestedAction || null,
      action_href: params.actionHref || null,
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(`创建任务失败: ${error.message}`)
  }

  // Record timeline event
  await recordTimelineEvent({
    entityType: 'orchestration_task',
    entityId: data.id as string,
    eventType: 'task_created',
    eventTitle: `任务创建: ${params.title}`,
    eventDetail: {
      severity: params.severity,
      source_module: params.sourceModule,
      source_entity_id: params.sourceEntityId,
      assignee_role: params.assigneeRole,
      rule_id: params.ruleId,
    },
    sourceType: params.ruleId ? 'system' : 'user',
    actorName: params.ruleId ? 'orchestration-engine' : undefined,
  })

  return data.id as string
}

export async function escalateTask(taskId: string): Promise<void> {
  const supabase = createClient()

  const { data: task, error: fetchError } = await supabase
    .from('orchestration_tasks')
    .select('id, title, severity, assignee_role, escalation_role, status')
    .eq('id', taskId)
    .single()

  if (fetchError || !task) {
    throw new Error(`任务不存在: ${taskId}`)
  }

  if (task.status === 'resolved' || task.status === 'closed' || task.status === 'cancelled') {
    return // Already done, nothing to escalate
  }

  // Upgrade severity
  const severityOrder: Record<string, string> = {
    info: 'warning',
    warning: 'critical',
    critical: 'urgent',
    urgent: 'urgent',
  }

  const newSeverity = severityOrder[task.severity as string] || 'critical'
  const escalationRole = (task.escalation_role as string) || 'finance_manager'

  const { error } = await supabase
    .from('orchestration_tasks')
    .update({
      status: 'escalated',
      severity: newSeverity,
      assignee_role: escalationRole,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)

  if (error) {
    throw new Error(`升级任务失败: ${error.message}`)
  }

  await recordTimelineEvent({
    entityType: 'orchestration_task',
    entityId: taskId,
    eventType: 'task_escalated',
    eventTitle: `任务升级: ${task.title}`,
    eventDetail: {
      previous_severity: task.severity,
      new_severity: newSeverity,
      escalated_to: escalationRole,
    },
    sourceType: 'system',
    actorName: 'orchestration-engine',
  })
}

export async function resolveTask(
  taskId: string,
  resolvedBy: string,
  note: string
): Promise<void> {
  const supabase = createClient()

  const { data: task, error: fetchError } = await supabase
    .from('orchestration_tasks')
    .select('id, title')
    .eq('id', taskId)
    .single()

  if (fetchError || !task) {
    throw new Error(`任务不存在: ${taskId}`)
  }

  const { error } = await supabase
    .from('orchestration_tasks')
    .update({
      status: 'resolved',
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
      resolution_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)

  if (error) {
    throw new Error(`解决任务失败: ${error.message}`)
  }

  await recordTimelineEvent({
    entityType: 'orchestration_task',
    entityId: taskId,
    eventType: 'task_resolved',
    eventTitle: `任务已解决: ${task.title}`,
    eventDetail: {
      resolved_by: resolvedBy,
      resolution_note: note,
    },
    sourceType: 'user',
    actorId: resolvedBy,
  })
}

export async function getPendingTasks(role?: string): Promise<Record<string, unknown>[]> {
  const supabase = createClient()

  let query = supabase
    .from('orchestration_tasks')
    .select('*')
    .in('status', ['pending', 'in_progress', 'escalated', 'blocked'])
    .order('severity', { ascending: true }) // urgent first
    .order('created_at', { ascending: false })

  if (role) {
    query = query.eq('assignee_role', role)
  }

  const { data, error } = await query

  if (error) {
    console.error('[orchestration] getPendingTasks failed:', error.message)
    return []
  }

  return (data ?? []) as Record<string, unknown>[]
}

// --------------- Overdue Escalation ---------------

export async function escalateOverdueTasks(): Promise<number> {
  const supabase = createClient()
  const now = new Date().toISOString()

  const { data: overdue } = await supabase
    .from('orchestration_tasks')
    .select('id')
    .eq('status', 'pending')
    .not('due_date', 'is', null)
    .lt('due_date', now)

  if (!overdue?.length) return 0

  let escalated = 0

  for (const task of overdue) {
    try {
      await escalateTask(task.id as string)
      escalated++
    } catch (err) {
      console.error(`[orchestration] Failed to escalate task ${task.id}:`, err)
    }
  }

  return escalated
}
