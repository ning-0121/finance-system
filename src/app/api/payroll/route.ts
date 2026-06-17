// ============================================================
// 工资条 API（finance_manager / admin）
// POST action=sync_employees → 从企业微信通讯录同步花名册
// POST action=send_batch     → 把某批次工资条逐人私发到企业微信
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { createClient } from '@/lib/supabase/server'
import { getDepartmentList, getDepartmentUsers, sendMarkdownMessage } from '@/lib/wecom/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COMPANY = '义乌市绮陌服饰有限公司'

function guard(role: string | undefined): boolean {
  return ['finance_manager', 'admin'].includes(role || '')
}

function buildSlipMarkdown(periodTitle: string, name: string, netPay: number, items: { label: string; amount: number }[]): string {
  const lines = items.map(it => {
    const neg = it.amount < 0
    return `> ${it.label}：${neg ? '-' : ''}¥${Math.abs(it.amount).toLocaleString()}`
  }).join('\n')
  return [
    `**【${COMPANY}】${periodTitle} 工资条**`,
    `> 姓名：${name}`,
    lines,
    `> **实发：<font color="info">¥${netPay.toLocaleString()}</font>**`,
    `如有疑问请联系财务，工资信息请勿外传。`,
  ].filter(Boolean).join('\n')
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  if (!guard(auth.role)) return NextResponse.json({ error: '仅财务经理/管理员可操作工资条' }, { status: 403 })

  try {
    const body = await request.json()
    const supabase = await createClient()

    if (body.action === 'sync_employees') {
      const deptRes = await getDepartmentList() as { department?: { id: number; name: string }[] }
      const depts = deptRes.department || []
      if (depts.length === 0) return NextResponse.json({ error: '企业微信未返回部门，请确认通讯录权限已配置' }, { status: 502 })
      const seen = new Set<string>()
      let synced = 0
      for (const dept of depts) {
        const usersRes = await getDepartmentUsers(dept.id) as { userlist?: { userid: string; name: string; email?: string; mobile?: string; status?: number }[] }
        for (const u of usersRes.userlist || []) {
          if (u.status !== undefined && u.status !== 1) continue
          if (seen.has(u.userid)) continue
          seen.add(u.userid)
          const { error } = await supabase.from('employees').upsert({
            name: u.name, wecom_userid: u.userid, department: dept.name,
            email: u.email || null, mobile: u.mobile || null, active: true, updated_at: new Date().toISOString(),
          }, { onConflict: 'wecom_userid' })
          if (!error) synced++
        }
      }
      return NextResponse.json({ success: true, synced })
    }

    if (body.action === 'send_batch') {
      const { batchId } = body
      if (!batchId) return NextResponse.json({ error: '缺少 batchId' }, { status: 400 })
      const { data: batch } = await supabase.from('payroll_batches').select('id, title').eq('id', batchId).maybeSingle()
      if (!batch) return NextResponse.json({ error: '批次不存在' }, { status: 404 })
      const { data: slips } = await supabase.from('payroll_slips').select('*').eq('batch_id', batchId).in('send_status', ['pending', 'failed'])
      let sent = 0, failed = 0, skipped = 0
      for (const s of slips || []) {
        if (!s.wecom_userid) {
          await supabase.from('payroll_slips').update({ send_status: 'skipped', send_error: '无企业微信账号，未匹配到花名册' }).eq('id', s.id)
          skipped++; continue
        }
        try {
          const md = buildSlipMarkdown(batch.title as string, s.employee_name as string, Number(s.net_pay), (s.items as { label: string; amount: number }[]) || [])
          const res = await sendMarkdownMessage({ touser: s.wecom_userid as string, content: md }) as { errcode?: number; errmsg?: string }
          if (res.errcode && res.errcode !== 0) throw new Error(res.errmsg || `errcode ${res.errcode}`)
          await supabase.from('payroll_slips').update({ send_status: 'sent', sent_at: new Date().toISOString(), send_error: null }).eq('id', s.id)
          sent++
        } catch (e) {
          await supabase.from('payroll_slips').update({ send_status: 'failed', send_error: e instanceof Error ? e.message : '发送失败' }).eq('id', s.id)
          failed++
        }
      }
      // 更新批次状态
      const { count: sentTotal } = await supabase.from('payroll_slips').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('send_status', 'sent')
      await supabase.from('payroll_batches').update({ sent_count: sentTotal || 0, status: (sentTotal || 0) > 0 ? 'sent' : 'draft' }).eq('id', batchId)
      return NextResponse.json({ success: true, sent, failed, skipped })
    }

    return NextResponse.json({ error: `未知操作: ${body.action}` }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '操作失败' }, { status: 500 })
  }
}
