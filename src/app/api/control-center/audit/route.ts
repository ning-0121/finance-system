// 审计检查 API
// GET /api/control-center/audit?status=open&severity=critical
// POST /api/control-center/audit
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  getAuditFindings,
  runFullAudit,
  resolveAuditFinding,
} from '@/lib/engines/audit-engine'
import { notifyRiskAlert, notifyCircuitBreaker } from '@/lib/wecom/notifications'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const { searchParams } = request.nextUrl
    const filters: { status?: string; severity?: string; entityType?: string } = {}

    const status = searchParams.get('status')
    const severity = searchParams.get('severity')
    const entityType = searchParams.get('entityType')

    if (status) filters.status = status
    if (severity) filters.severity = severity
    if (entityType) filters.entityType = entityType

    const data = await getAuditFindings(filters)
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[audit GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取审计结果失败' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const body = await request.json()
    const { action } = body

    switch (action) {
      case 'run_full': {
        const findings = await runFullAudit()

        // 审计完成后，按严重程度发送通知（非阻塞）
        if (findings?.length) {
          const critical = findings.filter((f: { severity: string; status: string }) => f.severity === 'critical' && f.status === 'open')
          const high = findings.filter((f: { severity: string; status: string }) => f.severity === 'high' && f.status === 'open')

          if (critical.length > 0) {
            // L4 熔断级通知
            notifyCircuitBreaker({
              customer: '财务系统',
              trigger: `发现 ${critical.length} 项严重审计异常`,
              description: critical.slice(0, 3).map((f: { title: string }) => f.title).join('；'),
              actions: ['立即查看审计报告', '暂停相关业务操作', '联系财务总监确认'],
            }).catch(err => console.error('[WeChat] 审计熔断通知失败:', err))
          } else if (high.length > 0) {
            // L2-L3 风险预警
            notifyRiskAlert({
              title: `审计发现 ${high.length} 项高风险问题`,
              riskLevel: 'yellow',
              description: high.slice(0, 3).map((f: { title: string }) => f.title).join('；'),
              suggestion: '请及时处理高风险审计发现',
            }).catch(err => console.error('[WeChat] 审计风险通知失败:', err))
          }
        }

        return NextResponse.json({ data: findings })
      }

      case 'resolve': {
        const { findingId, resolution } = body
        if (!findingId || !resolution) {
          return NextResponse.json({ error: '缺少 findingId 或 resolution' }, { status: 400 })
        }
        await resolveAuditFinding(findingId, resolution, auth.userId!)
        return NextResponse.json({ success: true })
      }

      default:
        return NextResponse.json({ error: `未知操作: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error('[audit POST]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '审计操作失败' },
      { status: 500 }
    )
  }
}
