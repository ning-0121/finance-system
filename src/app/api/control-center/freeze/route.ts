// 实体冻结管理 API
// GET /api/control-center/freeze?entityType=customer&status=frozen
// POST /api/control-center/freeze
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  getActiveFreezes,
  freezeEntity,
  requestUnfreeze,
  approveUnfreeze,
} from '@/lib/engines/freeze-engine'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const { searchParams } = request.nextUrl
    const entityType = searchParams.get('entityType') || undefined

    const data = await getActiveFreezes(entityType)
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[freeze GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取冻结记录失败' },
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
      case 'freeze': {
        const { entityType, entityId, entityName, reason } = body
        if (!entityType || !entityId || !entityName || !reason) {
          return NextResponse.json(
            { error: '缺少 entityType、entityId、entityName 或 reason' },
            { status: 400 }
          )
        }
        const result = await freezeEntity({
          entityType,
          entityId,
          entityName,
          reason,
          freezeType: 'manual',
          frozenBy: auth.userId!,
        })
        return NextResponse.json({ data: result })
      }

      case 'request_unfreeze': {
        const { freezeId, reason } = body
        if (!freezeId || !reason) {
          return NextResponse.json({ error: '缺少 freezeId 或 reason' }, { status: 400 })
        }
        await requestUnfreeze(freezeId, auth.userId!, reason)
        return NextResponse.json({ success: true })
      }

      case 'approve_unfreeze': {
        const { freezeId } = body
        if (!freezeId) {
          return NextResponse.json({ error: '缺少 freezeId' }, { status: 400 })
        }
        await approveUnfreeze(freezeId, auth.userId!)
        return NextResponse.json({ success: true })
      }

      default:
        return NextResponse.json({ error: `未知操作: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error('[freeze POST]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '冻结操作失败' },
      { status: 500 }
    )
  }
}
