/**
 * Wave 3 治理加固回归
 *
 * P1-E1 payable UNIQUE(settlement_id, invoice_id)
 *   1. 同一发票第二次进同一决算 → 唯一约束拒
 *   2. 软删除的应付不参与唯一约束
 *
 * P1-E2 get_or_create_customer RPC
 *   3. 名称已存在 → 返回现有 id, created=false
 *   4. 名称不存在 → 创建 + 返回 id, created=true
 *   5. 空名称 → RAISE CUSTOMER_NAME_EMPTY
 *
 * P1-E3 synced_orders version + bump trigger
 *   6. INSERT 默认 version=1
 *   7. UPDATE 不带 version 自动 +1
 *   8. .eq('version', X) 乐观锁失败 → 0 rows
 *
 * P1-E6 begin/end_period_close 关账锁
 *   9. open → closing 获锁成功
 *  10. 重复获锁 → PERIOD_CLOSE_IN_PROGRESS
 *  11. end_period_close 恢复 open
 */
import { createClient } from '@supabase/supabase-js'
import { hardDeleteForTest } from './_test-cleanup'

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s: string) => { console.log(`  \x1b[31m✗\x1b[0m ${s}`); process.exitCode = 1 }

;(async () => {
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║  Wave 3 · 治理加固回归                       ║')
  console.log('╚══════════════════════════════════════════════╝')

  let pass = 0, total = 0
  const trash: Array<{ table: string; id: string }> = []

  const { data: u } = await svc.auth.admin.listUsers({ perPage: 1 })
  const actorId = u!.users[0].id
  const { data: c } = await svc.from('customers').select('id').limit(1).single()

  // ━━━ P1-E1 应付唯一 ━━━
  console.log()
  console.log('━━━ P1-E1 payable UNIQUE(settlement_id, invoice_id) ━━━')

  const { data: bo1 } = await svc.from('budget_orders').insert({
    order_no: 'W3-E1-' + Date.now(), customer_id: c!.id, created_by: actorId,
    order_date: '2026-05-23', delivery_date: '2026-05-23', items: [],
    total_revenue: 100, total_cost: 50, estimated_profit: 50, estimated_margin: 50,
    currency: 'CNY', exchange_rate: 1, status: 'approved',
  }).select('id').single()
  trash.push({ table: 'budget_orders', id: bo1!.id })

  const { data: s1 } = await svc.from('order_settlements').insert({
    budget_order_id: bo1!.id, status: 'draft', sub_settlements: [], order_level_costs: {},
    total_budget: 100, total_actual: 100, total_variance: 0, final_profit: 50, final_margin: 50,
  }).select('id').single()
  trash.push({ table: 'order_settlements', id: s1!.id })

  const { data: inv } = await svc.from('actual_invoices').insert({
    budget_order_id: bo1!.id, invoice_no: 'W3-INV-' + Date.now(),
    invoice_type: 'supplier_invoice', supplier_name: 'X',
    total_amount: 100, currency: 'CNY', status: 'pending',
  }).select('id').single()
  trash.push({ table: 'actual_invoices', id: inv!.id })

  const payload = {
    budget_order_id: bo1!.id, settlement_id: s1!.id, invoice_id: inv!.id,
    supplier_name: 'X', description: 'X', cost_category: 'other',
    amount: 100, currency: 'CNY', payment_status: 'unpaid', over_budget: false,
  }
  const { data: p1 } = await svc.from('payable_records').insert(payload).select('id').single()
  if (p1) trash.push({ table: 'payable_records', id: p1.id })

  total++
  const { error: dupErr } = await svc.from('payable_records').insert(payload)
  if (dupErr && /uniq_payable_settlement_invoice/.test(dupErr.message)) {
    ok(`重复 (settlement, invoice) 被 UNIQUE 拒: ${dupErr.message.slice(0,60)}`); pass++
  } else bad(`未拦截: ${dupErr?.message || '(成功)'}`)

  total++
  // 软删原应付后，第二次允许插入
  await svc.from('payable_records').update({
    deleted_at: new Date().toISOString(), deleted_by: actorId, delete_reason: 'wave3 test',
  }).eq('id', p1!.id)
  const { data: p2, error: p2Err } = await svc.from('payable_records').insert(payload).select('id').single()
  if (!p2Err && p2) { ok(`软删后第二次插入成功（partial index 不阻挡）`); pass++; trash.push({ table: 'payable_records', id: p2.id }) }
  else bad(`partial index 错误: ${p2Err?.message}`)

  // ━━━ P1-E2 get_or_create_customer ━━━
  console.log()
  console.log('━━━ P1-E2 get_or_create_customer RPC ━━━')

  total++
  const newName = 'Wave3Test-' + Date.now()
  const { data: c1 } = await svc.rpc('get_or_create_customer' as never, { p_name: newName, p_currency: 'USD' } as never) as any
  if (c1?.id && c1.created === true) { ok(`新建 customer: ${c1.id?.slice(0,8)} created=true`); pass++ }
  else bad(`新建失败: ${JSON.stringify(c1)}`)

  total++
  const { data: c2 } = await svc.rpc('get_or_create_customer' as never, { p_name: newName, p_currency: 'USD' } as never) as any
  if (c2?.id === c1?.id && c2.created === false) { ok(`二次查询命中现有: created=false`); pass++ }
  else bad(`二次查询错: ${JSON.stringify(c2)}`)

  total++
  const { error: emptyErr } = await svc.rpc('get_or_create_customer' as never, { p_name: '', p_currency: 'USD' } as never) as any
  if (emptyErr && /CUSTOMER_NAME_EMPTY/.test(emptyErr.message)) { ok(`空名称被 RAISE`); pass++ }
  else bad(`空名称未拦截: ${emptyErr?.message}`)
  // 清新建客户
  if (c1?.id) await svc.from('customers').delete().eq('id', c1.id)

  // ━━━ P1-E3 synced_orders version ━━━
  console.log()
  console.log('━━━ P1-E3 synced_orders version + bump ━━━')

  total++
  const { data: so1 } = await svc.from('synced_orders').insert({
    id: crypto.randomUUID(),
    order_no: 'W3-SO-' + Date.now(),
    customer_name: 'X', lifecycle_status: 'draft',
    synced_at: new Date().toISOString(),
  }).select('version').single()
  if (so1?.version === 1) { ok(`INSERT 默认 version=1`); pass++ }
  else bad(`默认 version 错: ${so1?.version}`)

  total++
  const soId = (await svc.from('synced_orders').select('id').eq('order_no', 'W3-SO-' + Date.now().toString().slice(0,-2) + '00').single()).data?.id
  // 取上面刚插的 row
  const { data: soRow } = await svc.from('synced_orders').select('id, version').like('order_no', 'W3-SO-%').order('synced_at',{ascending:false}).limit(1).single()
  const { data: bumped } = await svc.from('synced_orders').update({ notes: 'test bump' }).eq('id', soRow!.id).select('version').single()
  if (bumped?.version === 2) { ok(`UPDATE 自动 +1: ${soRow!.version}→${bumped.version}`); pass++ }
  else bad(`bump 失败: ${soRow?.version}→${bumped?.version}`)

  total++
  // 乐观锁：用旧 version=1 更新 → 0 rows
  const { data: stale } = await svc.from('synced_orders').update({ notes: 'stale' }).eq('id', soRow!.id).eq('version', 1).select('id')
  if (!stale || stale.length === 0) { ok(`旧 version 乐观锁失败 → 0 rows`); pass++ }
  else bad(`乐观锁未生效: ${stale?.length} rows`)
  await svc.from('synced_orders').delete().eq('id', soRow!.id)

  // ━━━ P1-E6 begin/end_period_close ━━━
  console.log()
  console.log('━━━ P1-E6 关账锁 ━━━')

  const tp = '2098-12'
  await svc.from('accounting_periods').insert({ period_code: tp, status: 'open', year: 2098, month: 12, start_date: '2098-12-01', end_date: '2098-12-31' })

  total++
  const { data: l1, error: l1Err } = await svc.rpc('begin_period_close' as never, { p_period_code: tp } as never) as any
  if (!l1Err && l1?.acquired === true) { ok(`open → closing CAS 获锁`); pass++ }
  else bad(`获锁失败: ${l1Err?.message}`)

  total++
  const { error: l2Err } = await svc.rpc('begin_period_close' as never, { p_period_code: tp } as never) as any
  if (l2Err && /PERIOD_CLOSE_IN_PROGRESS/.test(l2Err.message)) { ok(`并发获锁被拒: ${l2Err.message.slice(0,60)}`); pass++ }
  else bad(`并发未拦截`)

  total++
  const { data: r1 } = await svc.rpc('end_period_close' as never, { p_period_code: tp, p_final_status: 'open' } as never) as any
  const { data: pAfter } = await svc.from('accounting_periods').select('status').eq('period_code', tp).single()
  if (r1?.released === true && pAfter?.status === 'open') { ok(`end_period_close 恢复 open`); pass++ }
  else bad(`恢复失败: released=${r1?.released}, status=${pAfter?.status}`)

  await svc.from('accounting_periods').delete().eq('period_code', tp)

  // ━━━ 清理 ━━━
  console.log()
  console.log('═══ 清理 ═══')
  await svc.from('financial_provenance').delete().in('target_id', trash.map(t => t.id))
  for (const t of trash.reverse()) {
    const r = await hardDeleteForTest(svc, t.table, t.id, 'wave3 governance test cleanup')
    if (!r.deleted && r.error && !/not_found/.test(r.error)) console.log(`  ⚠ ${t.table}/${t.id.slice(0,8)}: ${r.error}`)
  }

  console.log()
  console.log(`总计: ${pass}/${total} 通过`)
  process.exit(pass === total ? 0 : 1)
})().catch(e => { console.error(e); process.exit(1) })
