// 时间线事件 API
// GET /api/control-center/timeline?entityType=order&entityId=xxx&limit=50
// GET /api/control-center/timeline?recent=true&limit=20
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  getEntityTimeline,
  getRecentEvents,
} from '@/lib/engines/timeline-engine'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const { searchParams } = request.nextUrl
    const recent = searchParams.get('recent')

    if (recent === 'true') {
      const limit = parseInt(searchParams.get('limit') || '20', 10)
      const data = await getRecentEvents(limit)
      return NextResponse.json({ data })
    }

    const entityType = searchParams.get('entityType')
    const entityId = searchParams.get('entityId')

    if (!entityType || !entityId) {
      return NextResponse.json(
        { error: '缺少 entityType 或 entityId 参数（或使用 recent=true）' },
        { status: 400 }
      )
    }

    const limit = parseInt(searchParams.get('limit') || '50', 10)
    const data = await getEntityTimeline(entityType, entityId, { limit })
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[timeline GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取时间线失败' },
      { status: 500 }
    )
  }
}
