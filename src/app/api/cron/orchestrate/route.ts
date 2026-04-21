// ============================================================
// Cron API: /api/cron/orchestrate
// 定时任务入口 — 规则评估 + 任务升级 + 日报生成
// 由 Vercel Cron 或内部调用触发 (GET)
// ============================================================

import { NextResponse } from 'next/server'
import { runOrchestration, escalateOverdueTasks, getAutomationHealth } from '@/lib/engines/orchestration-engine'
import { generateDailyReport, formatReportAsMarkdown } from '@/lib/engines/report-engine'
import { recordTimelineEvent } from '@/lib/engines/timeline-engine'

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

    // 6. Return JSON summary
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
