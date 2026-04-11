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
