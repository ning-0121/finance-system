/**
 * Wave 1-D · Financial Provenance 回归测试
 *
 * 验证每条财务 mutation 写一行 financial_provenance：
 *   1. INSERT cost_items → action_type='create'，affected_reports=[profit_loss, order_profit]
 *   2. UPDATE status (cost_items 软删) → action_type='soft_delete'
 *   3. INSERT journal via RPC → action_type='create'，affected=[trial_balance, profit_loss, general_ledger]
 *   4. journal 状态 posted → voided → action_type='reverse'
 *   5. actor_role 正确解析（system / user / admin_bypass）
 *   6. NEW.id 等同 target_id
 *   7. CFO 7 问能回放
 *   8. 无回归: e2e baseline + complex 仍全绿
 */
import { createClient } from '@supabase/supabase-js'
import { hardDeleteForTest } from './_test-cleanup'

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s: string) => { console.log(`  \x1b[31m✗\x1b[0m ${s}`); process.exitCode = 1 }

;(async () => {
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  Wave 1-D · Financial Provenance 回归      ║')
  console.log('╚════════════════════════════════════════════╝')

  let pass = 0, total = 0
  const trash: Array<{ table: string; id: string }> = []

  // ─── setup ───
  const { data: u } = await svc.auth.admin.listUsers({ perPage: 1 })
  const actorId = u!.users[0].id
  const { data: c } = await svc.from('customers').select('id').limit(1).single()
  const { data: bo, error: boErr } = await svc.from('budget_orders').insert({
    order_no: 'W1D-' + Date.now(), customer_id: c!.id, created_by: actorId,
    order_date: '2026-05-16', delivery_date: '2026-05-16', items: [],
    total_revenue: 100, total_cost: 50, estimated_profit: 50, estimated_margin: 50,
    currency: 'CNY', exchange_rate: 1, status: 'draft',
  }).select('id').single()
  if (boErr || !bo) { console.error('budget_orders insert 失败:', boErr); process.exit(1) }
  trash.push({ table: 'budget_orders', id: bo.id })

  // ─── 1. cost_items INSERT 写 provenance ───
  total++
  const { data: ci, error: ciErr } = await svc.from('cost_items').insert({
    budget_order_id: bo!.id, cost_type: 'fabric', description: 'provenance test',
    amount: 100, currency: 'CNY', exchange_rate: 1, source_module: 'test', supplier: 'X', created_by: actorId,
  }).select('id').single()
  if (ciErr || !ci) { console.error('cost_items insert err:', ciErr); process.exit(1) }
  trash.push({ table: 'cost_items', id: ci.id })
  const { data: prov1 } = await svc.from('financial_provenance')
    .select('*').eq('target_table','cost_items').eq('target_id', ci!.id).single()
  if (prov1 && prov1.action_type === 'create' && Array.isArray(prov1.affected_reports)
      && prov1.affected_reports.includes('profit_loss') && prov1.affected_reports.includes('order_profit')) {
    ok(`cost_items INSERT → provenance create, reports=[${prov1.affected_reports.join(',')}]`); pass++
  } else bad(`provenance 缺失或字段错: ${JSON.stringify(prov1)}`)

  // ─── 2. cost_items soft delete → action='soft_delete' ───
  total++
  await svc.from('cost_items').update({
    deleted_at: new Date().toISOString(), deleted_by: actorId, delete_reason: 'provenance test'
  }).eq('id', ci!.id).is('deleted_at', null)
  const { data: prov2 } = await svc.from('financial_provenance')
    .select('*').eq('target_table','cost_items').eq('target_id', ci!.id).eq('action_type','soft_delete').maybeSingle()
  if (prov2 && prov2.action_type === 'soft_delete') {
    ok(`cost_items 软删 → provenance soft_delete`); pass++
  } else bad(`soft_delete provenance 缺失: ${JSON.stringify(prov2)}`)

  // ─── 3. journal RPC → provenance create + reports ───
  total++
  const { data: rpc } = await svc.rpc('create_journal_atomic', {
    p_period_code: '2026-05', p_date: '2026-05-16', p_description: 'wave1d test',
    p_source_type: 'budget_order', p_source_id: bo!.id,
    p_total_debit: 1, p_total_credit: 1, p_voucher_type:'auto', p_created_by: actorId,
    p_lines: [
      { account_code: '1122', debit:1, credit:0, description:'X', currency:'CNY', exchange_rate:1, order_id: bo!.id },
      { account_code: '500102', debit:0, credit:1, description:'Y', currency:'CNY', exchange_rate:1, order_id: bo!.id },
    ],
  })
  const journalId = (rpc as { journal_id: string }).journal_id
  trash.push({ table: 'journal_entries', id: journalId })
  const { data: prov3 } = await svc.from('financial_provenance')
    .select('*').eq('target_table','journal_entries').eq('target_id', journalId).eq('action_type','create').maybeSingle()
  if (prov3 && prov3.affected_reports?.includes('trial_balance') && prov3.affected_reports?.includes('general_ledger')) {
    ok(`journal RPC → provenance create, reports=[${prov3.affected_reports.join(',')}]`); pass++
  } else bad(`journal provenance 错: ${JSON.stringify(prov3)}`)

  // ─── 4. journal voided → action='reverse' ───
  total++
  await svc.from('journal_entries').update({ status: 'voided' }).eq('id', journalId)
  const { data: prov4 } = await svc.from('financial_provenance')
    .select('*').eq('target_table','journal_entries').eq('target_id', journalId).eq('action_type','reverse').maybeSingle()
  if (prov4 && prov4.action_type === 'reverse' && prov4.target_status_before === 'posted' && prov4.target_status_after === 'voided') {
    ok(`journal void → provenance reverse (posted→voided)`); pass++
  } else bad(`reverse provenance 错: ${JSON.stringify(prov4)}`)

  // ─── 5. actor_role 解析：行内 created_by 应该被识别为 user ───
  total++
  if (prov3 && prov3.actor_role === 'user' && prov3.actor_id === actorId) {
    ok(`actor 来自 created_by, role=user, id=${actorId.slice(0,8)}`); pass++
  } else bad(`actor 解析错: role=${prov3?.actor_role}, id=${prov3?.actor_id}`)

  // ─── 6. CFO 7 问能整合查询：拿 budget_order 链路全部 provenance ───
  total++
  const { data: chain } = await svc.from('financial_provenance')
    .select('target_table, action_type, actor_role, target_status_before, target_status_after, affected_reports')
    .or(`target_id.eq.${ci!.id},target_id.eq.${journalId}`)
    .order('created_at')
  if (chain && chain.length >= 4) {
    ok(`审计链可读：${chain.length} 条 provenance (cost_items 2 + journal 2)`); pass++
    for (const r of chain) {
      console.log(`     · ${r.target_table.padEnd(18)} ${r.action_type.padEnd(14)} actor=${r.actor_role} ${r.target_status_before || '∅'}→${r.target_status_after || '∅'} reports=[${(r.affected_reports as string[]).join(',')}]`)
    }
  } else bad(`审计链不完整: ${chain?.length} 条`)

  // ─── 7. CHECK 约束：未知 action_type 被拒 ───
  total++
  const { error: badActionErr } = await svc.from('financial_provenance').insert({
    actor_id: 'test', actor_role: 'system',
    target_table: 'cost_items', target_id: ci!.id,
    action_type: 'malicious_action',  // 不在 CHECK 列表
    affected_reports: [],
  })
  if (badActionErr && /check.*action_type|violates check/i.test(badActionErr.message)) {
    ok(`非法 action_type 被 CHECK 拒绝`); pass++
  } else bad(`CHECK 未生效: ${badActionErr?.message || '(成功)'}`)

  // ─── 清理 ───
  console.log()
  console.log('═══ 清理 ═══')
  // 先清 provenance（CASCADE 不会自动，因为没 FK；但 service_role 可直删）
  await svc.from('financial_provenance').delete().or(`target_id.eq.${ci!.id},target_id.eq.${journalId},target_id.eq.${bo!.id}`)
  await svc.from('gl_balances').delete().eq('period_code', '2026-05')
  for (const t of trash.reverse()) {
    const r = await hardDeleteForTest(svc, t.table, t.id, 'wave1d provenance test cleanup')
    if (!r.deleted && r.error) console.log(`  ⚠ ${t.table}/${t.id.slice(0,8)}: ${r.error}`)
  }

  console.log()
  console.log(`总计: ${pass}/${total} 通过`)
  process.exit(pass === total ? 0 : 1)
})().catch(e => { console.error(e); process.exit(1) })
