// ============================================================
// POST /api/integration/receivable-receipt
// 杂项应收(misc_receivables,如打样费)确认收款:置 received + 记真身 + 回传节拍器 collection.received(闭环)。
// 铁律:真身 auth.uid() 作收款人,财务角色限定;集成通道(x-api-key)不得代人确认收款。
// ============================================================
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { notifyFinanceProgress } from '@/lib/integration/client'

export async function POST(request: Request) {
  try {
    if (request.headers.get('x-api-key')) {
      return NextResponse.json({ error: '收款须由财务在系统内操作,集成通道不受理' }, { status: 403 })
    }
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
    if (!profile || !['admin', 'finance_manager', 'finance_staff'].includes(profile.role as string)) {
      return NextResponse.json({ error: '需要财务角色权限' }, { status: 403 })
    }

    const body = await request.json() as { id?: string; received_amount?: number; received_at?: string }
    if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    // 读当前应收:必须 open 才能收款
    const { data: mr, error: readErr } = await supabase
      .from('misc_receivables')
      .select('id, status, kind, amount, currency, order_no, qimo_order_id, source_ref')
      .eq('id', body.id).is('deleted_at', null).maybeSingle()
    if (readErr) return NextResponse.json({ error: `读取失败: ${readErr.message}` }, { status: 500 })
    if (!mr) return NextResponse.json({ error: '应收不存在' }, { status: 404 })
    if (mr.status !== 'open') return NextResponse.json({ error: `当前状态(${mr.status})不可收款` }, { status: 409 })

    const receivedAmount = body.received_amount != null && Number(body.received_amount) > 0
      ? Number(body.received_amount) : Number(mr.amount)
    const receivedAt = body.received_at || new Date().toISOString()

    // 置 received(乐观锁:只在 open 时更新,防并发/重复),记真身收款人
    const { data: updated, error: updErr } = await supabase
      .from('misc_receivables')
      .update({ status: 'received', received_amount: receivedAmount, received_at: receivedAt, received_by: user.id, updated_at: new Date().toISOString() })
      .eq('id', body.id).eq('status', 'open')
      .select('id')
    if (updErr) return NextResponse.json({ error: `收款失败: ${updErr.message}` }, { status: 500 })
    if (!updated?.length) return NextResponse.json({ error: '该应收已被处理,请刷新后重试' }, { status: 409 })

    // 回传节拍器 collection.received(闭环)。失败落 outbox 可重试(notifyFinanceProgress 内部)。
    const callback = await notifyFinanceProgress('collection.received', {
      qimo_order_id: (mr.qimo_order_id as string) || null,
      order_no: (mr.order_no as string) || null,
      amount: receivedAmount,
      currency: (mr.currency as string) || 'CNY',
      note: `${(mr.kind as string) || 'sample_fee'} 收款`,
      source_ref: (mr.source_ref as string) || `mr-${body.id}`,
    })

    return NextResponse.json({ status: 'ok', received: true, callback_sent: callback.success })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
