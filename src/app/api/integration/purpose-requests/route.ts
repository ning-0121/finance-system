// ============================================================
// 节拍器「订单用途变更」待审批 —— 财务侧代理
//   GET  → 签名拉取节拍器待审批申请(fetchPendingPurposeRequestsFromMetronome)
//   POST → 财务审批 → sendApprovalToMetronome(approval_type='order_purpose')回传节拍器执行
// 鉴权:Supabase Auth + 财务角色。审批人一律取真身,绝不信客户端传入(铁律)。
// 申请单据在节拍器侧(order_purpose_change_requests),财务侧无本地行,故不做本地行更新。
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  fetchPendingPurposeRequestsFromMetronome,
  sendApprovalToMetronome,
} from '@/lib/integration/client'

const FINANCE_ROLES = ['admin', 'finance_manager', 'finance_staff']

async function requireFinance() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase.from('profiles').select('role, name').eq('id', user.id).single()
  if (!profile || !FINANCE_ROLES.includes(profile.role as string)) {
    return { error: NextResponse.json({ error: '需要财务角色权限' }, { status: 403 }) }
  }
  return { userId: user.id, userName: (profile.name as string) || '财务' }
}

export async function GET() {
  const auth = await requireFinance()
  if ('error' in auth) return auth.error
  const r = await fetchPendingPurposeRequestsFromMetronome()
  if (!r.success) return NextResponse.json({ error: r.error || '拉取失败', data: [] }, { status: 502 })
  return NextResponse.json({ data: r.data || [] })
}

export async function POST(request: Request) {
  const auth = await requireFinance()
  if ('error' in auth) return auth.error

  let body: { approval_id?: string; decision?: string; decision_note?: string | null }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const { approval_id, decision } = body
  if (!approval_id || !decision) return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  if (!['approved', 'rejected'].includes(decision)) return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
  const sanitizedNote = body.decision_note ? String(body.decision_note).slice(0, 500) : null

  // 回传节拍器执行(approval_type='order_purpose';审批人=真身)
  const callbackResult = await sendApprovalToMetronome({
    approval_id,
    approval_type: 'order_purpose',
    decision: decision as 'approved' | 'rejected',
    decided_by: auth.userId,
    decider_name: String(auth.userName).slice(0, 100),
    decision_note: sanitizedNote,
    decided_at: new Date().toISOString(),
  })

  const supabase = await createClient()
  await supabase.from('integration_logs').insert({
    event_type: 'approval.callback',
    direction: 'outbound',
    request_id: `approve-order_purpose-${approval_id}-${decision}`,
    source: 'finance-system',
    status: callbackResult.success ? 'success' : 'failed',
    payload_summary: JSON.stringify({ approval_id, approval_type: 'order_purpose', decision }).slice(0, 500),
    error_message: callbackResult.error || null,
  }).then(() => {}, () => {})

  if (!callbackResult.success) {
    return NextResponse.json({ error: `回传节拍器失败:${callbackResult.error}(已入 outbox 重试)`, callback_sent: false }, { status: 502 })
  }
  return NextResponse.json({ status: 'ok', callback_sent: true })
}
