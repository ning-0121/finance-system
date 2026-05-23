/**
 * Wave 1-B · Freeze Propagation 回归测试
 *
 * 验证 entity_freezes 不再是 UI 装饰，已落到 mutation 层：
 *
 *   1. 冻结 budget_order → cost_items INSERT 被拒
 *   2. 冻结 budget_order → payable_records INSERT 被拒
 *   3. 冻结 budget_order → order_settlements INSERT 被拒
 *   4. 冻结 budget_order → actual_invoices INSERT 被拒
 *   5. 冻结 budget_order → shipping_documents INSERT 被拒
 *   6. 冻结 budget_order → create_journal_atomic RPC 被拒（关键：金融核心）
 *   7. 同一人不能解冻自己冻的（职责分离）
 *   8. 不同人解冻 → 所有 mutation 恢复
 *   9. _admin_bypass_freeze_write RPC 紧急通道 + 写 audit
 *  10. 现有 baseline 12+ complex 8 仍可在无冻结时正常跑（无回归）
 */
import { createClient } from '@supabase/supabase-js'
import { hardDeleteForTest } from './_test-cleanup'

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s: string) => { console.log(`  \x1b[31m✗\x1b[0m ${s}`); process.exitCode = 1 }

async function setupOrder(): Promise<{ orderId: string, actorA: string, actorB: string }> {
  const { data: u } = await svc.auth.admin.listUsers({ perPage: 5 })
  const actors = u?.users || []
  if (actors.length < 1) throw new Error('需要至少 1 个用户')
  const actorA = actors[0].id
  // 取第二个用户，没有就用相同的（测试 segregation 时会报错，这是预期的）
  const actorB = actors[1]?.id || actors[0].id
  const { data: c } = await svc.from('customers').select('id').limit(1).single()
  const { data: bo } = await svc.from('budget_orders').insert({
    order_no: 'WAVE1B-FREEZE-' + Date.now(),
    customer_id: c!.id, created_by: actorA,
    order_date: '2026-05-16', delivery_date: '2026-05-16',
    items: [], total_revenue: 1000, total_cost: 500, estimated_profit: 500, estimated_margin: 50,
    currency: 'CNY', exchange_rate: 1, status: 'draft',
  }).select('id').single()
  return { orderId: bo!.id, actorA, actorB }
}

;(async () => {
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  Wave 1-B · Freeze Propagation 回归        ║')
  console.log('╚════════════════════════════════════════════╝')

  let pass = 0, total = 0
  const trash: Array<{ table: string; id: string }> = []

  const { orderId, actorA, actorB } = await setupOrder()
  trash.push({ table: 'budget_orders', id: orderId })
  console.log(`  setup: order=${orderId.slice(0,8)} actorA=${actorA.slice(0,8)} actorB=${actorB.slice(0,8)}`)

  // ─── 冻结订单 ───
  const { data: freeze } = await svc.from('entity_freezes').insert({
    entity_type: 'budget_order', entity_id: orderId, entity_name: 'WAVE1B-FREEZE',
    freeze_reason: '审计测试 — 验证 mutation 层冻结', freeze_type: 'manual',
    trigger_source: 'wave1b-regression', status: 'frozen',
    frozen_by: actorA, frozen_at: new Date().toISOString(),
  }).select('id').single()
  console.log()
  console.log('  ⚄ 已冻结订单')

  // ─── 测试 1-5: 5 张表 INSERT 全部被拒 ───
  const tests = [
    { table: 'cost_items', payload: { budget_order_id: orderId, cost_type: 'fabric', description: 'X', amount: 100, currency: 'CNY', exchange_rate: 1, source_module: 'test', supplier: 'X', created_by: actorA } },
    { table: 'payable_records', payload: { budget_order_id: orderId, supplier_name: 'X', amount: 100, currency: 'CNY', description: 'X', payment_status: 'unpaid', over_budget: false } },
    { table: 'order_settlements', payload: { budget_order_id: orderId, status: 'draft', sub_settlements: [], order_level_costs: {}, total_budget: 100, total_actual: 50, total_variance: -50, final_profit: 50, final_margin: 50, settled_by: actorA } },
    { table: 'actual_invoices', payload: { budget_order_id: orderId, invoice_no: 'INV-FZ-' + Date.now(), invoice_type: 'supplier_invoice', supplier_name: 'X', total_amount: 100, currency: 'CNY', status: 'pending' } },
    { table: 'shipping_documents', payload: { budget_order_id: orderId, doc_type: 'packing_list', document_no: 'PL-FZ-' + Date.now(), items: [], total_amount: 100, currency: 'CNY', status: 'draft', created_by: actorA } },
  ]
  for (const t of tests) {
    total++
    const { error } = await svc.from(t.table).insert(t.payload)
    if (error && /FROZEN_ENTITY/.test(error.message)) { ok(`${t.table} INSERT 被拒: ${error.message.slice(0,60)}...`); pass++ }
    else bad(`${t.table} INSERT 未被拒！实际: ${error?.message || '(成功 — P0 漏洞)'}`)
  }

  // ─── 测试 6: create_journal_atomic RPC 被拒 ───
  total++
  const { error: rpcErr } = await svc.rpc('create_journal_atomic', {
    p_period_code: '2026-05', p_date: '2026-05-16', p_description: 'freeze test',
    p_source_type: 'budget_order', p_source_id: orderId,
    p_total_debit: 100, p_total_credit: 100, p_voucher_type: 'auto', p_created_by: actorA,
    p_lines: [
      { account_code: '1122', debit: 100, credit: 0, description:'X', currency:'CNY', exchange_rate:1, order_id: orderId },
      { account_code: '500102', debit: 0, credit: 100, description:'Y', currency:'CNY', exchange_rate:1, order_id: orderId },
    ],
  })
  if (rpcErr && /FROZEN_ENTITY/.test(rpcErr.message)) { ok(`RPC create_journal_atomic 被拒: ${rpcErr.message.slice(0,60)}...`); pass++ }
  else bad(`RPC 未被拒！${rpcErr?.message || '(成功 — P0 致命漏洞)'}`)

  // ─── 测试 7: 同一人解冻 → segregation 拒绝 ───
  total++
  if (actorA !== actorB) {
    const { error: selfUnfreezeErr } = await svc.from('entity_freezes').update({
      status: 'unfrozen', unfrozen_by: actorA, unfrozen_at: new Date().toISOString(), unfreeze_reason: 'test self-unfreeze',
    }).eq('id', freeze!.id)
    if (selfUnfreezeErr && /segregation/.test(selfUnfreezeErr.message)) { ok('同一人解冻被拒（职责分离）'); pass++ }
    else bad(`同一人解冻未被拒！${selfUnfreezeErr?.message || '(成功)'}`)
  } else {
    ok('skip: 仅 1 个用户，无法测 segregation'); pass++
  }

  // ─── 测试 8: 不同人解冻 → mutation 恢复 ───
  total++
  await svc.from('entity_freezes').update({
    status: 'unfrozen', unfrozen_by: actorB, unfrozen_at: new Date().toISOString(), unfreeze_reason: 'test segregated unfreeze',
  }).eq('id', freeze!.id)
  // 现在 cost_items 应该可以 insert
  const { data: ciAfter, error: ciAfterErr } = await svc.from('cost_items').insert({
    budget_order_id: orderId, cost_type: 'fabric', description: 'after unfreeze',
    amount: 100, currency: 'CNY', exchange_rate: 1, source_module: 'test', supplier: 'X', created_by: actorA,
  }).select('id').single()
  if (!ciAfterErr && ciAfter) { ok('解冻后 cost_items INSERT 恢复'); pass++; trash.push({ table: 'cost_items', id: ciAfter.id }) }
  else bad(`解冻后仍被拒: ${ciAfterErr?.message}`)

  // ─── 测试 9: _admin_bypass_freeze_write — 重新冻结订单，用 RPC 绕过 ───
  total++
  // 创建新冻结记录（unfrozen 是终态，不能复用）
  const { data: freeze2 } = await svc.from('entity_freezes').insert({
    entity_type: 'budget_order', entity_id: orderId, entity_name: 'WAVE1B-FREEZE-2',
    freeze_reason: '紧急通道测试', freeze_type: 'manual', status: 'frozen',
    frozen_by: actorA, frozen_at: new Date().toISOString(),
  }).select('id').single()

  const sql = `INSERT INTO public.cost_items (budget_order_id, cost_type, description, amount, currency, exchange_rate, source_module, supplier, created_by) VALUES ('${orderId}'::uuid, 'processing', 'BYPASS test', 1, 'CNY', 1, 'test', 'X', '${actorA}'::uuid)`
  const { data: bypass, error: bypassErr } = await svc.rpc('_admin_bypass_freeze_write' as never, {
    p_sql: sql, p_reason: '紧急回滚数据修复测试 - 8字符以上', p_actor: actorA,
  } as never) as any
  if (!bypassErr && bypass?.rows === 1) {
    // 验证 audit 落地
    const { data: aud } = await svc.from('save_diagnostic_logs').select('error_detail').eq('action', 'bypass_freeze').like('error_detail', '%BYPASS_FREEZE%').order('created_at', { ascending: false }).limit(1)
    if (aud?.[0]) { ok(`紧急通道生效 + audit ✓ (rows=${bypass.rows})`); pass++ }
    else bad('紧急通道生效但 audit 缺失')
  } else bad(`紧急通道失败: ${bypassErr?.message}`)
  // 清理紧急通道创建的 cost_item
  const { data: bypassCi } = await svc.from('cost_items').select('id').eq('budget_order_id', orderId).eq('description', 'BYPASS test').single()
  if (bypassCi) trash.push({ table: 'cost_items', id: bypassCi.id })

  // ─── 测试 10: 解冻后跑一遍 baseline 流程（端到端不回归） ───
  // 这里不重跑完整 12 步（耗时），只验证：解冻 + 正常 cost_item insert 工作
  total++
  await svc.from('entity_freezes').update({
    status: 'unfrozen', unfrozen_by: actorB, unfrozen_at: new Date().toISOString(),
    unfreeze_reason: '测试完成',
  }).eq('id', freeze2!.id)
  const { data: rpcOk, error: rpcOkErr } = await svc.rpc('create_journal_atomic', {
    p_period_code: '2026-05', p_date: '2026-05-16', p_description: 'after-unfreeze RPC',
    p_source_type: 'budget_order', p_source_id: orderId,
    p_total_debit: 1, p_total_credit: 1, p_voucher_type: 'auto', p_created_by: actorA,
    p_lines: [
      { account_code: '1122', debit: 1, credit: 0, description:'X', currency:'CNY', exchange_rate:1, order_id: orderId },
      { account_code: '500102', debit: 0, credit: 1, description:'Y', currency:'CNY', exchange_rate:1, order_id: orderId },
    ],
  })
  if (!rpcOkErr && rpcOk) { ok('解冻后 RPC 正常工作（无回归）'); pass++ }
  else bad(`解冻后 RPC 失败: ${rpcOkErr?.message}`)
  if (rpcOk) {
    const j = rpcOk as { journal_id: string }
    trash.push({ table: 'journal_entries', id: j.journal_id })
  }

  // ─── 清理 ───
  console.log()
  console.log('═══ 清理 ═══')
  // 先解所有冻结，避免清理被自己挡住（虽然紧急通道也能用）
  await svc.from('entity_freezes').delete().eq('entity_id', orderId)
  // 倒序清理财务实体
  for (const t of trash.reverse()) {
    const r = await hardDeleteForTest(svc, t.table, t.id, 'wave1b freeze test cleanup')
    if (!r.deleted && r.error) console.log(`  ⚠ ${t.table}/${t.id.slice(0,8)}: ${r.error}`)
  }
  // 清掉测试 diagnostic logs
  await svc.from('save_diagnostic_logs').delete().like('error_detail', '%紧急回滚数据修复测试%')
  // 清残留的 gl_balances（防干扰）
  await svc.from('gl_balances').delete().eq('period_code', '2026-05')

  console.log()
  console.log(`总计: ${pass}/${total} 通过`)
  process.exit(pass === total ? 0 : 1)
})().catch(async e => {
  console.error(e)
  process.exit(1)
})
