// ============================================================
// Cron API: /api/cron/orchestrate
// 定时任务入口 — 规则评估 + 任务升级 + 日报生成 + 逾期通知
// 由 Vercel Cron 或内部调用触发 (GET)
// ============================================================

import { NextResponse } from 'next/server'
import { runOrchestration, escalateOverdueTasks, getAutomationHealth } from '@/lib/engines/orchestration-engine'
import { generateDailyReport, formatReportAsMarkdown } from '@/lib/engines/report-engine'
import { recordTimelineEvent } from '@/lib/engines/timeline-engine'
import { notifyPaymentReminder, notifyCollectionReminder } from '@/lib/wecom/notifications'
import { pushDailyDigestToGroup } from '@/lib/wecom/robot'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Allow up to 60s for full orchestration run

export async function GET(request: Request) {
  const startTime = Date.now()

  try {
    // Verify cron secret — must be configured, no fallback open access
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET 未配置，拒绝执行' }, { status: 500 })
    }
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 支持dry-run模式
    const url = new URL(request.url)
    const isDryRun = url.searchParams.get('dryRun') === 'true'
    const executionId = `cron-${Date.now()}`

    // 1. Run orchestration — evaluate all automation rules
    const orchestrationResult = await runOrchestration({ dryRun: isDryRun, executionId, actor: 'cron' })

    // 2. Escalate overdue tasks
    const escalatedCount = await escalateOverdueTasks()

    // 3. Generate daily report
    const dailyReport = await generateDailyReport()
    const reportMarkdown = await formatReportAsMarkdown(dailyReport)

    const durationMs = Date.now() - startTime

    // 4. Record timeline event for this run
    await recordTimelineEvent({
      entityType: 'system',
      entityId: 'orchestration-cron',
      eventType: 'cron_run',
      eventTitle: `编排引擎运行完成 (${durationMs}ms)`,
      eventDetail: {
        rules_evaluated: orchestrationResult.rulesEvaluated,
        rules_triggered: orchestrationResult.rulesTriggered,
        tasks_created: orchestrationResult.tasksCreated,
        tasks_escalated: escalatedCount,
        actions_executed: orchestrationResult.actionsExecuted,
        report_date: dailyReport.date,
        duration_ms: durationMs,
      },
      sourceType: 'system',
      actorName: 'cron/orchestrate',
    })

    // 5. Get automation health score
    const health = await getAutomationHealth()

    // 6. 发送逾期应付提醒通知（非阻塞，仅在非dry-run模式）
    if (!isDryRun) {
      // 6a. 逾期应付提醒
      sendOverduePayableReminders().catch(err =>
        console.error('[cron] 逾期应付提醒发送失败:', err)
      )

      // 6b. 逾期应收提醒（严重逾期60天+）
      sendOverdueReceivableReminders().catch(err =>
        console.error('[cron] 逾期应收提醒发送失败:', err)
      )

      // 6c. 推送日报到群机器人（如果配置了webhook）
      if (process.env.WECOM_ROBOT_WEBHOOK_KEY) {
        pushDailyDigestToGroup({
          cashBalance: 0,
          weekInflow: dailyReport.kpi?.revenue || 0,
          weekOutflow: 0,
          riskCount: dailyReport.risks?.open || 0,
          pendingApprovals: dailyReport.tasks?.pending || 0,
          topIssue: dailyReport.explanations?.[0]?.text || '系统运行正常',
        }).catch(err => console.error('[cron] 日报推送失败:', err))
      }
    }

    // 7. Return JSON summary
    return NextResponse.json({
      success: true,
      dryRun: isDryRun,
      executionId,
      timestamp: new Date().toISOString(),
      durationMs,
      orchestration: {
        rulesEvaluated: orchestrationResult.rulesEvaluated,
        rulesTriggered: orchestrationResult.rulesTriggered,
        tasksCreated: orchestrationResult.tasksCreated,
        actionsExecuted: orchestrationResult.actionsExecuted.length,
        escalatedTasks: escalatedCount,
      },
      report: {
        date: dailyReport.date,
        role: dailyReport.role,
        kpi: dailyReport.kpi,
        risks: dailyReport.risks,
        tasks: dailyReport.tasks,
        explanationCount: dailyReport.explanations.length,
        topExplanation: dailyReport.explanations[0]?.text || null,
      },
      reportMarkdown,
      automationHealth: health,
    })
  } catch (error) {
    const durationMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    console.error('[cron/orchestrate] Failed:', errorMessage)

    // Still try to record the failure in timeline
    try {
      await recordTimelineEvent({
        entityType: 'system',
        entityId: 'orchestration-cron',
        eventType: 'cron_error',
        eventTitle: `编排引擎运行失败`,
        eventDetail: {
          error: errorMessage,
          duration_ms: durationMs,
        },
        sourceType: 'system',
        actorName: 'cron/orchestrate',
      })
    } catch {
      // Ignore timeline recording failure
    }

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        durationMs,
      },
      { status: 500 }
    )
  }
}

// ============================================================
// 内部函数：逾期应付提醒
// ============================================================
async function sendOverduePayableReminders(): Promise<void> {
  const supabase = await createClient()
  const today = new Date().toISOString().substring(0, 10)

  const { data: overdue } = await supabase
    .from('payable_records')
    .select('supplier_name, amount, currency, due_date')
    .eq('payment_status', 'unpaid')
    .lt('due_date', today)
    .order('due_date', { ascending: true })
    .limit(10) // 每次最多发10条，避免通知轰炸

  if (!overdue?.length) return

  // 按供应商合并，发送汇总提醒
  const supplierMap = new Map<string, { amount: number; currency: string; dueDate: string }>()
  for (const r of overdue) {
    const key = r.supplier_name
    const existing = supplierMap.get(key)
    if (!existing || r.due_date < existing.dueDate) {
      supplierMap.set(key, {
        amount: (existing?.amount || 0) + r.amount,
        currency: r.currency || 'CNY',
        dueDate: r.due_date || today,
      })
    } else {
      existing.amount += r.amount
    }
  }

  for (const [supplier, info] of supplierMap.entries()) {
    await notifyPaymentReminder({
      supplier,
      amount: info.amount,
      currency: info.currency,
      dueDate: info.dueDate,
      affectsProduction: true, // 逾期应付可能影响供应商关系
    }).catch(err => console.error(`[cron] 供应商付款提醒失败 ${supplier}:`, err))
  }
}

// ============================================================
// 内部函数：逾期应收提醒（60天+严重逾期）
// ============================================================
async function sendOverdueReceivableReminders(): Promise<void> {
  const supabase = await createClient()
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 60) // 60天前到期
  const cutoff = cutoffDate.toISOString().substring(0, 10)

  const { data: overdue } = await supabase
    .from('budget_orders')
    .select('order_no, customer:customers(company), total_revenue, currency, delivery_date')
    .eq('status', 'approved')
    .gt('total_revenue', 0)
    .lt('delivery_date', cutoff)
    .limit(5) // 只通知最严重的5条

  if (!overdue?.length) return

  for (const order of overdue) {
    if (!order.total_revenue) continue
    const deliveryDate = new Date(order.delivery_date as string)
    const dueDate = new Date(deliveryDate)
    dueDate.setDate(dueDate.getDate() + 30) // 交货后30天应收

    const overdueDays = Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24))

    await notifyCollectionReminder({
      customer: (order.customer as { company?: string } | null)?.company || order.order_no as string,
      orderNo: order.order_no as string,
      amount: order.total_revenue as number,
      currency: (order.currency as string) || 'USD',
      overdueDays,
    }).catch(err => console.error(`[cron] 应收提醒失败 ${order.order_no}:`, err))
  }
}
