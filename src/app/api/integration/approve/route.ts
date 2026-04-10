// ============================================================
// POST /api/integration/approve
// 财务系统审批后，回调通知订单节拍器
// 内部调用 — 由财务系统前端触发
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendApprovalToMetronome } from '@/lib/integration/client'
import type { ApprovalDecision } from '@/lib/integration/types'

export async function POST(request: Request) {
  try {
    const body = await request.json() as ApprovalDecision
    const { approval_id, approval_type, decision, decided_by, decider_name, decision_note } = body

    if (!approval_id || !approval_type || !decision || !decided_by) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!['approved', 'rejected'].includes(decision)) {
      return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
    }

    const supabase = await createClient()

    // 1. 更新本地审批状态
    const { error: updateError } = await supabase
      .from('pending_approvals')
      .update({
        status: decision,
        decided_by,
        decider_name,
        decision_note,
        decided_at: new Date().toISOString(),
      })
      .eq('id', approval_id)

    if (updateError) {
      return NextResponse.json({ error: `Update failed: ${updateError.message}` }, { status: 500 })
    }

    // 2. 回调节拍器
    const callbackResult = await sendApprovalToMetronome({
      approval_id,
      approval_type,
      decision,
      decided_by,
      decider_name,
      decision_note: decision_note || null,
      decided_at: new Date().toISOString(),
    })

    // 3. 记录回调结果
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
      callback_error: callbackResult.error,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
