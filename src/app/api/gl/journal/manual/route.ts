// POST /api/gl/journal/manual — 手工录入记账凭证（草稿）
// 财务录入 → draft（requires_review=true）→ 财务经理在凭证列表「过账」（post_journal 强校验+更新 gl_balances）。
// 走既有 create_journal_draft RPC：期间校验/借贷平衡/原子写入/溯源齐全；创建人记真实 auth.uid()。
import { NextResponse, type NextRequest } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'

type ManualLine = { account_code: string; description?: string; debit: number; credit: number }

const r2 = (n: number) => Math.round(n * 100) / 100

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const roleErr = requireRole(auth, ['finance_staff', 'finance_manager', 'admin'])
  if (roleErr) return roleErr

  try {
    const body = await request.json() as { date?: string; description?: string; lines?: ManualLine[] }
    const date = (body.date || '').slice(0, 10)
    const description = (body.description || '').trim()
    const lines = Array.isArray(body.lines) ? body.lines : []

    // ── 基本校验 ──
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: '日期格式应为 YYYY-MM-DD' }, { status: 400 })
    if (!description) return NextResponse.json({ error: '请填写凭证摘要' }, { status: 400 })
    if (lines.length < 2) return NextResponse.json({ error: '至少需要两条分录（一借一贷）' }, { status: 400 })

    let totalDebit = 0, totalCredit = 0
    for (const [i, l] of lines.entries()) {
      const d = r2(Number(l.debit) || 0), c = r2(Number(l.credit) || 0)
      if (!l.account_code?.trim()) return NextResponse.json({ error: `第 ${i + 1} 行未选择科目` }, { status: 400 })
      if (d === 0 && c === 0) return NextResponse.json({ error: `第 ${i + 1} 行借贷金额都为 0` }, { status: 400 })
      if (d !== 0 && c !== 0) return NextResponse.json({ error: `第 ${i + 1} 行借贷金额只能填一边` }, { status: 400 })
      totalDebit = r2(totalDebit + d); totalCredit = r2(totalCredit + c)
    }
    if (Math.abs(totalDebit - totalCredit) > 0.001) {
      return NextResponse.json({ error: `借贷不平衡：借方 ${totalDebit} ≠ 贷方 ${totalCredit}` }, { status: 400 })
    }

    const supabase = await createClient()

    // ── 科目校验：必须是启用的明细科目 ──
    const codes = [...new Set(lines.map(l => l.account_code.trim()))]
    const { data: accs, error: accErr } = await supabase.from('accounts')
      .select('account_code, is_detail, is_active').in('account_code', codes)
    if (accErr) return NextResponse.json({ error: `科目校验失败：${accErr.message}` }, { status: 500 })
    const accMap = new Map((accs || []).map(a => [a.account_code as string, a]))
    for (const code of codes) {
      const a = accMap.get(code)
      if (!a) return NextResponse.json({ error: `科目 ${code} 不存在，请先到科目表维护` }, { status: 400 })
      if (!a.is_active) return NextResponse.json({ error: `科目 ${code} 已停用` }, { status: 400 })
      if (!a.is_detail) return NextResponse.json({ error: `科目 ${code} 是汇总科目，只能用明细科目记账` }, { status: 400 })
    }

    // ── 建草稿（RPC 内再校验期间存在/未关闭 + 借贷平衡；原子写入 header+lines）──
    const periodCode = date.slice(0, 7)
    const { data, error } = await supabase.rpc('create_journal_draft', {
      p_period_code: periodCode,
      p_date: date,
      p_description: description,
      p_source_type: 'manual',
      p_source_id: randomUUID(),           // 手工凭证的溯源 id（post_journal 要求非空）
      p_total_debit: totalDebit,
      p_total_credit: totalCredit,
      p_created_by: auth.userId,           // 真实登录人，不信任客户端传入
      p_lines: lines.map((l, i) => ({
        line_no: i + 1,
        account_code: l.account_code.trim(),
        description: (l.description || '').trim() || description,
        debit: r2(Number(l.debit) || 0),
        credit: r2(Number(l.credit) || 0),
      })),
      p_business_event: 'manual_entry',
      p_explanation: '手工录入凭证',
      p_requires_review: true,             // 草稿必经财务经理复核过账
    })
    if (error) {
      const msg = error.message.includes('PERIOD_MISSING') ? `会计期间 ${periodCode} 不存在，请先到「会计期间」页创建`
        : error.message.includes('PERIOD_CLOSED') ? `会计期间 ${periodCode} 已关闭，不能录凭证`
        : error.message
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    const journalId = (data as { journal_id?: string })?.journal_id
    const voucherNo = (data as { voucher_no?: string })?.voucher_no
    // RPC 固定写 voucher_type='auto'，手工凭证改回 manual（尽力而为，失败不影响凭证本身）
    if (journalId) {
      const { error: vtErr } = await supabase.from('journal_entries').update({ voucher_type: 'manual' }).eq('id', journalId)
      if (vtErr) console.error('[gl/manual] voucher_type update:', vtErr.message)
    }

    return NextResponse.json({ success: true, journal_id: journalId, voucher_no: voucherNo, status: 'draft' })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '录入失败' }, { status: 500 })
  }
}
