// ============================================================
// POST /api/integration/approve
// 财务系统审批后回调节拍器
// 安全：API Key + 签名验证（来自节拍器的集成请求）
//       或 Supabase Auth（来自财务系统前端）
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendApprovalToMetronome } from '@/lib/integration/client'
import type { ApprovalDecision } from '@/lib/integration/types'

export async function POST(request: Request) {
  try {
    // 鉴权(审计修 2026-07-05):集成调用不再只验静态 API Key(持 key 即可伪造审批),
    // 改用 validateRequest 全套 = API Key + HMAC 签名 + 时间戳窗口(与 webhook 同强度)。
    // 前端调用仍走 Supabase Auth + 角色。请求体只能读一次,按分支各自读取。
    const apiKey = request.headers.get('x-api-key')
    let body: ApprovalDecision
    let trustedActorId: string          // 审批人一律取真身,绝不信客户端传入(铁律)
    let trustedActorName: string
    if (apiKey) {
      // 审计P1.3:机器/集成通道不得代人写审批结论(违反铁律「机器不得代人审批」)。
      // 本路由唯一调用方是财务前端(IntegrationApprovals.tsx,走 Supabase Auth),节拍器只发起
      // 审批【请求】(webhook),不该决策。x-api-key 决策分支=后门,直接拒绝。
      return NextResponse.json({ error: '审批须由财务在系统内操作,集成通道不受理审批决策' }, { status: 403 })
    } else {
      // 前端调用：必须验证登录状态和角色，无演示模式绕过
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role, name')
        .eq('id', user.id)
        .single()

      if (!profile || !['admin', 'finance_manager', 'finance_staff'].includes(profile.role)) {
        return NextResponse.json({ error: '需要财务角色权限' }, { status: 403 })
      }
      body = await request.json() as ApprovalDecision
      trustedActorId = user.id                                        // 真实登录人,忽略 body.decided_by
      trustedActorName = (profile.name as string) || '财务'
    }

    // 审批人一律用真身覆盖客户端传入值(审计P1.3:防伪造留痕)
    const { approval_id, approval_type, decision, decision_note } = body
    const decided_by = trustedActorId
    const decider_name = trustedActorName

    if (!approval_id || !approval_type || !decision || !decided_by) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!['approved', 'rejected'].includes(decision)) {
      return NextResponse.json({ error: 'Invalid decision value' }, { status: 400 })
    }

    // 限制comment长度
    const sanitizedNote = decision_note ? String(decision_note).slice(0, 500) : null

    const supabase = await createClient()

    // 更新本地审批状态（乐观锁：只更新 status=pending 的记录，防止并发双重审批）
    const { data: updated, error: updateError } = await supabase
      .from('pending_approvals')
      .update({
        status: decision,
        decided_by,
        decider_name: String(decider_name || '').slice(0, 100),
        decision_note: sanitizedNote,
        decided_at: new Date().toISOString(),
      })
      .eq('id', approval_id)
      .eq('status', 'pending') // 乐观锁：已审批则不更新
      .select('id')

    if (updateError) {
      return NextResponse.json({ error: `Update failed: ${updateError.message}` }, { status: 500 })
    }
    if (!updated?.length) {
      return NextResponse.json({ error: '该审批单已被处理，请勿重复操作' }, { status: 409 })
    }

    // 回调节拍器
    const callbackResult = await sendApprovalToMetronome({
      approval_id,
      approval_type,
      decision,
      decided_by,
      decider_name: String(decider_name || '').slice(0, 100),
      decision_note: sanitizedNote,
      decided_at: new Date().toISOString(),
    })

    // 记录日志
    await supabase.from('integration_logs').insert({
      event_type: 'approval.callback',
      direction: 'outbound',
      request_id: `approve-${approval_id}`,
      source: 'finance-system',
      status: callbackResult.success ? 'success' : 'failed',
      payload_summary: JSON.stringify({ approval_id, approval_type, decision }).slice(0, 500),
      error_message: callbackResult.error || null,
    })

    return NextResponse.json({
      status: 'ok',
      local_updated: true,
      callback_sent: callbackResult.success,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
