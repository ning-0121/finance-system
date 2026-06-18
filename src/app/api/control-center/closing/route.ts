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
  getMonthlyClosingPanel,
  requestPeriodReopen,
  approvePeriodReopen,
} from '@/lib/engines/closing-engine'
import { createClient } from '@/lib/supabase/server'
import { notifyRiskAlert } from '@/lib/wecom/notifications'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const { searchParams } = request.nextUrl
    const period = searchParams.get('period')
    if (!period) {
      return NextResponse.json({ error: '缺少 period 参数' }, { status: 400 })
    }

    const [data, panel, periodRow] = await Promise.all([
      getClosingStatus(period),
      getMonthlyClosingPanel(period),
      (await createClient()).from('accounting_periods')
        .select('status, closed_at, reopen_requested_by, reopen_requested_at, reopen_reason')
        .eq('period_code', period).maybeSingle().then(r => r.data),
    ])
    return NextResponse.json({ data, panel, period: periodRow })
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

    // 关账类写操作需财务经理/管理员；override(强制跳过检查)更敏感，限管理员
    const role = auth.role || ''
    const managerActions = ['init', 'run_all', 'run_one', 'finalize', 'override']
    if (managerActions.includes(action) && !['finance_manager', 'admin'].includes(role)) {
      return NextResponse.json({ error: '关账操作需财务经理或管理员权限' }, { status: 403 })
    }
    if (action === 'override' && role !== 'admin') {
      return NextResponse.json({ error: '强制跳过检查项(override)仅管理员可操作' }, { status: 403 })
    }

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

        // 关账成功后发送企业微信通知（非阻塞）
        notifyRiskAlert({
          title: `${period} 期间已关账`,
          riskLevel: 'green',
          description: `${period} 期间所有检查通过，已完成关账操作`,
          suggestion: '请完成期间报表归档',
        }).catch(err => console.error('[WeChat] 关账通知失败:', err))

        return NextResponse.json({ data: result })
      }

      case 'request_reopen': {
        const { period, reason } = body
        if (!period || !reason) return NextResponse.json({ error: '缺少 period 或解锁原因' }, { status: 400 })
        if (!['finance_manager', 'admin'].includes(auth.role || '')) {
          return NextResponse.json({ error: '仅财务经理/管理员可申请解锁' }, { status: 403 })
        }
        const result = await requestPeriodReopen(period, reason, auth.userId!)
        if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 })
        notifyRiskAlert({
          title: `${period} 解锁申请`,
          riskLevel: 'yellow',
          description: `财务申请解锁已关账期间 ${period}：${reason}`,
          suggestion: '请管理员到月结中心审批',
        }).catch(err => console.error('[WeChat] 解锁申请通知失败:', err))
        return NextResponse.json({ success: true })
      }

      case 'approve_reopen': {
        const { period } = body
        if (!period) return NextResponse.json({ error: '缺少 period' }, { status: 400 })
        if (auth.role !== 'admin') {
          return NextResponse.json({ error: '仅管理员可批准解锁' }, { status: 403 })
        }
        const result = await approvePeriodReopen(period, auth.userId!)
        if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 })
        return NextResponse.json({ success: true })
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
