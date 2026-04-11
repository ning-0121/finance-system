// 信任评分 API
// GET /api/control-center/trust?subjectType=customer
// GET /api/control-center/trust?subjectType=customer&subjectId=xxx
// POST /api/control-center/trust
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  getTrustDashboard,
  getTrustProfile,
  recalculateAllTrustScores,
  downgradeTrust,
  recordTrustSnapshot,
} from '@/lib/engines/trust-engine'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const { searchParams } = request.nextUrl
    const subjectType = searchParams.get('subjectType')
    const subjectId = searchParams.get('subjectId')

    // 查询单个信任档案
    if (subjectType && subjectId) {
      const data = await getTrustProfile(subjectType, subjectId)
      return NextResponse.json({ data })
    }

    // 获取信任仪表盘
    const data = await getTrustDashboard()
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[trust GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取信任数据失败' },
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
      case 'recalculate': {
        const result = await recalculateAllTrustScores()
        return NextResponse.json({ data: result })
      }

      case 'downgrade': {
        const { subjectType, subjectId, reason } = body
        if (!subjectType || !subjectId || !reason) {
          return NextResponse.json(
            { error: '缺少 subjectType、subjectId 或 reason' },
            { status: 400 }
          )
        }
        await downgradeTrust(subjectType, subjectId, reason)
        return NextResponse.json({ success: true })
      }

      case 'snapshot': {
        await recordTrustSnapshot()
        return NextResponse.json({ success: true })
      }

      default:
        return NextResponse.json({ error: `未知操作: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error('[trust POST]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '信任操作失败' },
      { status: 500 }
    )
  }
}
