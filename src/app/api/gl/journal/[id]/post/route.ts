// POST /api/gl/journal/[id]/post — 财务经理复核通过后，将 draft 凭证过账
// 仅 admin / finance_manager 可操作（试运行边界：人工 review 后才 posted）
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { classifyGlError } from '@/lib/accounting/gl-journal-builders'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const roleErr = requireRole(auth, ['admin', 'finance_manager'])
  if (roleErr) return roleErr

  try {
    const { id: journalId } = await params
    const supabase = await createClient()

    const { error } = await supabase.rpc('post_journal', { p_journal_id: journalId, p_posted_by: auth.userId })
    if (error) {
      return NextResponse.json({ error: `过账失败: ${error.message}`, code: classifyGlError(error) }, { status: 400 })
    }

    // 同步关联队列项 → posted，并关闭其 open 异常
    const { data: qRows } = await supabase.from('gl_posting_queue').select('id').eq('journal_id', journalId)
    const queueIds = (qRows || []).map(r => (r as { id: string }).id)
    await supabase.from('gl_posting_queue').update({
      status: 'posted', approved_by: auth.userId, requires_review: false, updated_at: new Date().toISOString(),
    }).eq('journal_id', journalId)
    if (queueIds.length > 0) {
      await supabase.from('audit_findings').update({
        status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: auth.userId, resolution_note: '复核通过并过账',
      }).eq('finding_type', 'gl_posting_failure').eq('status', 'open').in('entity_id', queueIds)
    }

    return NextResponse.json({ success: true, journalId, status: 'posted' })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '过账失败' }, { status: 500 })
  }
}
