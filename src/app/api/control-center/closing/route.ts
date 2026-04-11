// 关账管理 API
// GET /api/control-center/closing?period=2026-04
// POST /api/control-center/closing
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  getClosingStatus,
  initClosingChecklist,
  runFullClosingChecklist,
  executeClosingCheck,
  overrideCheck,
  finalizePeriodClose,
} from '@/lib/engines/closing-engine'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const { searchParams } = request.nextUrl
    const period = searchParams.get('period')
    if (!period) {
      return NextResponse.json({ error: '缺少 period 参数' }, { status: 400 })
    }

    const data = await getClosingStatus(period)
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[closing GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取关账状态失败' },
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
      case 'init': {
        const { period, closeType } = body
        if (!period || !closeType) {
          return NextResponse.json({ error: '缺少 period 或 closeType' }, { status: 400 })
        }
        await initClosingChecklist(period, closeType)
        return NextResponse.json({ success: true })
      }

      case 'run_all': {
        const { period } = body
        if (!period) {
          return NextResponse.json({ error: '缺少 period' }, { status: 400 })
        }
        const result = await runFullClosingChecklist(period)
        return NextResponse.json({ data: result })
      }

      case 'run_one': {
        const { period, checkKey } = body
        if (!period || !checkKey) {
          return NextResponse.json({ error: '缺少 period 或 checkKey' }, { status: 400 })
        }
        const result = await executeClosingCheck(period, checkKey)
        return NextResponse.json({ data: result })
      }

      case 'override': {
        const { period, checkKey, reason } = body
        if (!period || !checkKey || !reason) {
          return NextResponse.json({ error: '缺少 period、checkKey 或 reason' }, { status: 400 })
        }
        await overrideCheck(period, checkKey, reason, auth.userId!)
        return NextResponse.json({ success: true })
      }

      case 'finalize': {
        const { period } = body
        if (!period) {
          return NextResponse.json({ error: '缺少 period' }, { status: 400 })
        }
        const result = await finalizePeriodClose(period, auth.userId!)
        return NextResponse.json({ data: result })
      }

      default:
        return NextResponse.json({ error: `未知操作: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error('[closing POST]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '关账操作失败' },
      { status: 500 }
    )
  }
}
