// ============================================================
// POST /api/integration/approve
// 财务系统审批后回调节拍器
// 安全：API Key + 签名验证（来自节拍器的集成请求）
//       或 Supabase Auth（来自财务系统前端）
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendApprovalToMetronome } from '@/lib/integration/client'
import { verifyApiKey } from '@/lib/integration/security'
import type { ApprovalDecision } from '@/lib/integration/types'

export async function POST(request: Request) {
  try {
    // 鉴权：检查API Key（集成调用）或 Supabase Auth（前端调用）
    const apiKey = request.headers.get('x-api-key')
    const isIntegrationCall = apiKey && verifyApiKey(apiKey)

    if (!isIntegrationCall) {
      // 前端调用：验证用户登录状态和权限
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        // 演示模式放行
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        if (!supabaseUrl || supabaseUrl === 'your_supabase_url_here') {
          // demo mode - continue
        } else {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
      } else {
        // 验证角色权限
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single()

        if (profile && !['admin', 'finance_manager'].includes(profile.role)) {
          return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
        }
      }
    }

    const body = await request.json() as ApprovalDecision
    const { approval_id, approval_type, decision, decided_by, decider_name, decision_note } = body

    if (!approval_id || !approval_type || !decision || !decided_by) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!['approved', 'rejected'].includes(decision)) {
      return NextResponse.json({ error: 'Invalid decision value' }, { status: 400 })
    }

    // 限制comment长度
    const sanitizedNote = decision_note ? String(decision_note).slice(0, 500) : null

    const supabase = await createClient()

    // 更新本地审批状态
    const { error: updateError } = await supabase
      .from('pending_approvals')
      .update({
        status: decision,
        decided_by,
        decider_name: String(decider_name || '').slice(0, 100),
        decision_note: sanitizedNote,
        decided_at: new Date().toISOString(),
      })
      .eq('id', approval_id)

    if (updateError) {
      return NextResponse.json({ error: `Update failed: ${updateError.message}` }, { status: 500 })
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
