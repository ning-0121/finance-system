// ============================================================
// GET /api/search?q=关键词 — 全局跨表搜索
// 支持订单号/PO号/客户名/供应商/金额模糊搜索
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { escapeIlike } from '@/lib/utils'

// 简单内存限流：每用户每分钟最多 60 次搜索
const searchRateMap = new Map<string, { count: number; resetAt: number }>()
function checkSearchRate(userId: string): boolean {
  const now = Date.now()
  const e = searchRateMap.get(userId)
  if (!e || now > e.resetAt) { searchRateMap.set(userId, { count: 1, resetAt: now + 60_000 }); return true }
  if (e.count >= 60) return false
  e.count++
  return true
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  if (!checkSearchRate(auth.userId!)) {
    return NextResponse.json({ error: '搜索过于频繁，请稍后再试' }, { status: 429 })
  }

  const q = request.nextUrl.searchParams.get('q')?.trim()
  if (!q || q.length < 2) return NextResponse.json({ results: [] })
  if (q.length > 200) return NextResponse.json({ error: '搜索词过长' }, { status: 400 })

  try {
    const supabase = await createClient()
    const results: { type: string; title: string; subtitle: string; href: string }[] = []
    const safe = escapeIlike(q)
    const pattern = `%${safe}%`

    // 1. 搜索订单
    const { data: orders } = await supabase
      .from('budget_orders')
      .select('id, order_no, total_revenue, currency, status, customers(company)')
      .or(`order_no.ilike.${pattern},notes.ilike.${pattern}`)
      .limit(5)

    if (orders) {
      for (const o of orders) {
        const cust = o.customers as unknown as Record<string, unknown> | null
        results.push({
          type: '订单',
          title: o.order_no,
          subtitle: `${(cust?.company as string) || ''} · ${o.currency} ${o.total_revenue?.toLocaleString() || 0} · ${o.status}`,
          href: `/orders/${o.id}`,
        })
      }
    }

    // 2. 搜索客户
    const { data: customers } = await supabase
      .from('customers')
      .select('id, company, country, currency')
      .or(`company.ilike.${pattern},name.ilike.${pattern},country.ilike.${pattern}`)
      .limit(5)

    if (customers) {
      for (const c of customers) {
        results.push({
          type: '客户',
          title: c.company,
          subtitle: `${c.country || ''} · ${c.currency}`,
          href: `/profiles/customers`,
        })
      }
    }

    // 3. 搜索发票
    const { data: invoices } = await supabase
      .from('actual_invoices')
      .select('id, invoice_no, supplier_name, total_amount, currency, invoice_type')
      .or(`invoice_no.ilike.${pattern},supplier_name.ilike.${pattern}`)
      .limit(5)

    if (invoices) {
      for (const inv of invoices) {
        results.push({
          type: '发票',
          title: inv.invoice_no,
          subtitle: `${inv.supplier_name || ''} · ${inv.currency} ${inv.total_amount?.toLocaleString() || 0}`,
          href: `/costs`,
        })
      }
    }

    // 4. 搜索费用
    const { data: costs } = await supabase
      .from('cost_items')
      .select('id, description, amount, currency, cost_type')
      .ilike('description', pattern)
      .limit(5)

    if (costs) {
      for (const c of costs) {
        results.push({
          type: '费用',
          title: c.description,
          subtitle: `${c.cost_type} · ${c.currency} ${c.amount?.toLocaleString() || 0}`,
          href: `/costs`,
        })
      }
    }

    // 5. 搜索风险事件
    const { data: risks } = await supabase
      .from('financial_risk_events')
      .select('id, title, risk_type, risk_level, status')
      .or(`title.ilike.${pattern},description.ilike.${pattern}`)
      .limit(3)

    if (risks) {
      for (const r of risks) {
        results.push({
          type: '风险',
          title: r.title,
          subtitle: `${r.risk_level} · ${r.status}`,
          href: `/risks`,
        })
      }
    }

    // 6. 搜索冻结记录
    const { data: freezes } = await supabase
      .from('entity_freezes')
      .select('id, entity_name, entity_type, freeze_reason, status')
      .or(`entity_name.ilike.${pattern},freeze_reason.ilike.${pattern}`)
      .limit(3)

    if (freezes) {
      for (const f of freezes) {
        results.push({
          type: '冻结',
          title: `${f.entity_name} (${f.entity_type})`,
          subtitle: `${f.status === 'frozen' ? '已冻结' : '已解冻'} · ${f.freeze_reason}`,
          href: '/control-center/freeze',
        })
      }
    }

    // 7. 搜索稽核异常
    const { data: findings } = await supabase
      .from('audit_findings')
      .select('id, title, severity, entity_type, status')
      .or(`title.ilike.${pattern},description.ilike.${pattern}`)
      .limit(3)

    if (findings) {
      for (const f of findings) {
        results.push({
          type: '稽核',
          title: f.title,
          subtitle: `${f.severity} · ${f.entity_type} · ${f.status === 'open' ? '待处理' : '已处理'}`,
          href: '/control-center/audit',
        })
      }
    }

    // 8. 搜索凭证
    const { data: journals } = await supabase
      .from('journal_entries')
      .select('id, voucher_no, description, total_debit, status')
      .or(`voucher_no.ilike.${pattern},description.ilike.${pattern}`)
      .limit(3)

    if (journals) {
      for (const j of journals) {
        results.push({
          type: '凭证',
          title: j.voucher_no,
          subtitle: `${j.description} · ¥${(j.total_debit as number)?.toLocaleString() || 0} · ${j.status === 'posted' ? '已过账' : j.status}`,
          href: '/gl/journal',
        })
      }
    }

    return NextResponse.json({ results, query: q, total: results.length })
  } catch (error) {
    return NextResponse.json({ results: [], error: error instanceof Error ? error.message : 'Search failed' })
  }
}
