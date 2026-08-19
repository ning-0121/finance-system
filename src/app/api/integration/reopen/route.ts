// ============================================================
// POST /api/integration/reopen
// 财务「撤销重审」:把已处理(批准/驳回)的集成审批打回 pending,重新决策。
// 场景:误触批准/驳回后需更正(如价格审批本应驳回却误批)。
//
// 铁律遵循:
//  - 真身 auth.uid() 作操作人,绝不信客户端传入;财务角色限定(与 approve 同强度)。
//  - 集成通道(x-api-key)不得代人撤销(机器不得代人审批/撤销)。
//  - 原决策 + 撤销人 + 原因 留痕到 integration_logs(不静默改动)。
//  - 本路由【不直接回传节拍器】:重开后由正常审批流程(重新驳回/批准)再回传更正,
//    复用已加固、带 outbox 的回传链路,避免新增一条特权回传路径。
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    // 集成通道(持 x-api-key)不受理撤销 —— 同 approve:机器不得代人写审批结论
    if (request.headers.get('x-api-key')) {
      return NextResponse.json({ error: '撤销须由财务在系统内操作,集成通道不受理' }, { status: 403 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role, name').eq('id', user.id).single()
    if (!profile || !['admin', 'finance_manager', 'finance_staff'].includes(profile.role as string)) {
      return NextResponse.json({ error: '需要财务角色权限' }, { status: 403 })
    }

    const body = await request.json() as { approval_id?: string; reason?: string }
    const approval_id = body.approval_id
    const reason = body.reason ? String(body.reason).slice(0, 500) : ''
    if (!approval_id) return NextResponse.json({ error: 'Missing approval_id' }, { status: 400 })
    if (!reason.trim()) return NextResponse.json({ error: '撤销原因必填' }, { status: 400 })

    // 读当前记录:只有已处理(approved/rejected)才能撤销重审
    const { data: cur, error: readErr } = await supabase
      .from('pending_approvals')
      .select('id, status, decider_name, decided_by, decided_at, decision_note, approval_type, order_no')
      .eq('id', approval_id).maybeSingle()
    if (readErr) return NextResponse.json({ error: `读取失败: ${readErr.message}` }, { status: 500 })
    if (!cur) return NextResponse.json({ error: '审批记录不存在' }, { status: 404 })

    const oldStatus = (cur.status as string) || ''
    if (!['approved', 'rejected'].includes(oldStatus)) {
      return NextResponse.json(
        { error: oldStatus === 'pending' ? '该审批仍在待处理,无需撤销' : `当前状态(${oldStatus})不可撤销重审` },
        { status: 409 },
      )
    }

    // 打回 pending(乐观锁:只在仍是原已处理状态时更新,防并发/重复点击)
    const { data: updated, error: updErr } = await supabase
      .from('pending_approvals')
      .update({ status: 'pending', decided_by: null, decider_name: null, decided_at: null, decision_note: null })
      .eq('id', approval_id).in('status', ['approved', 'rejected'])
      .select('id')
    if (updErr) return NextResponse.json({ error: `撤销失败: ${updErr.message}` }, { status: 500 })
    if (!updated?.length) return NextResponse.json({ error: '该审批已被撤销或再次处理,请刷新查看最新状态' }, { status: 409 })

    // P1-4(审计 2026-07-28):作废 outbox 里该审批的旧决策回传。否则「首批时回传失败入 outbox」的旧
    // 批准/驳回会在撤销改判后被 cron 重投节拍器,把更正翻盘(request_id 不同,节拍器幂等拦不住)。
    // 置 dead 留痕(不物理删);outbox 写是 service-role 专属(RLS 只读),故用 service client。失败不阻断撤销。
    try {
      const { createServiceClient } = await import('@/lib/supabase/service')
      // 前缀匹配:request_id 现含 decided_at 后缀(2026-08-19 幂等键修复),精确 in() 会漏杀
      const { data: killed } = await createServiceClient().from('fin_outbound_outbox')
        .update({ status: 'dead', last_error: `superseded: 撤销重审作废旧决策回传(by ${profile.name || user.id})` })
        .eq('target', 'metronome').eq('event', 'approval.callback')
        .like('request_id', `fin-approval-${cur.approval_type}-${approval_id}-%`).eq('status', 'failed')
        .select('id')
      if (killed?.length) console.log(`[reopen] 已作废 ${killed.length} 条旧决策回传(outbox)`)
    } catch (e) { console.error('[reopen] outbox 清理失败(不阻断撤销):', e instanceof Error ? e.message : e) }

    // 审计留痕:原决策 + 撤销人真身 + 原因(非阻断:留痕失败只告警,不回滚已完成的撤销)
    const { error: logErr } = await supabase.from('integration_logs').insert({
      event_type: 'approval.reopened',
      direction: 'outbound',
      request_id: `reopen-${approval_id}-${Date.now()}`,
      source: 'finance-system',
      status: 'warning',
      payload_summary: JSON.stringify({
        approval_id,
        approval_type: cur.approval_type,
        order_no: cur.order_no,
        old_status: oldStatus,
        old_decider: cur.decider_name,
        old_decided_at: cur.decided_at,
        old_note: cur.decision_note,
        reopened_by: user.id,
        reopened_by_name: profile.name,
        reason,
      }).slice(0, 500),
    })
    if (logErr) console.error('[reopen] 审计留痕失败(撤销已完成):', logErr.message)

    return NextResponse.json({ status: 'ok', reopened: true, old_status: oldStatus })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
