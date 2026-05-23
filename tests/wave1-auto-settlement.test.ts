/**
 * Auto-Settlement on Shipping Completion 回归
 *
 *   1. shipping_documents → 'completed' 自动建 order_settlements draft
 *   2. settlement.auto_generated=true, source_shipping_id 指向 shipping
 *   3. 幂等：第二张 PL 不再重复建
 *   4. auto-generated draft 不能由 system 自动 confirm（必须人工）
 *   5. 冻结订单 → shipping 完结被 freeze guard 拦截（连带 settlement 也不建）
 *   6. provenance overlay 同时记录两层（shipping_documents + order_settlements）
 *   7. save_diagnostic_logs 有 auto_create 记录
 */
import { createClient } from '@supabase/supabase-js'
import { hardDeleteForTest } from './_test-cleanup'

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s: string) => { console.log(`  \x1b[31m✗\x1b[0m ${s}`); process.exitCode = 1 }

;(async () => {
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  Auto-Settlement on Shipping Completion    ║')
  console.log('╚════════════════════════════════════════════╝')

  let pass = 0, total = 0
  const trash: Array<{ table: string; id: string }> = []

  const { data: u } = await svc.auth.admin.listUsers({ perPage: 2 })
  const actorA = u!.users[0].id
  const actorB = u!.users[1]?.id || actorA
  const { data: c } = await svc.from('customers').select('id').limit(1).single()

  const { data: bo } = await svc.from('budget_orders').insert({
    order_no: 'AUTOST-' + Date.now(), customer_id: c!.id, created_by: actorA,
    order_date: '2026-05-16', delivery_date: '2026-05-16', items: [],
    total_revenue: 1000, total_cost: 500, estimated_profit: 500, estimated_margin: 50,
    currency: 'CNY', exchange_rate: 1, status: 'approved',
  }).select('id').single()
  trash.push({ table: 'budget_orders', id: bo!.id })

  // ─── 1. ship 完结 → 自动建 settlement ───
  total++
  const { data: ship1 } = await svc.from('shipping_documents').insert({
    budget_order_id: bo!.id, doc_type: 'packing_list', document_no: 'PL-AUTOST-1',
    items: [{ quantity: 500 }], total_amount: 500, currency: 'USD', status: 'completed', created_by: actorA,
  }).select('id').single()
  trash.push({ table: 'shipping_documents', id: ship1!.id })

  const { data: settled } = await svc.from('order_settlements').select('*').eq('budget_order_id', bo!.id)
  if (settled?.length === 1 && settled[0].auto_generated === true && settled[0].source_shipping_id === ship1!.id && settled[0].status === 'draft') {
    ok(`ship 完结 → auto-generated draft settlement (auto=${settled[0].auto_generated}, source=${ship1!.id.slice(0,8)})`); pass++
    trash.push({ table: 'order_settlements', id: settled[0].id })
  } else bad(`auto settlement 不正确: ${JSON.stringify(settled)}`)

  // ─── 2. 幂等：第二张 PL completed 不再建 ───
  total++
  const { data: ship2 } = await svc.from('shipping_documents').insert({
    budget_order_id: bo!.id, doc_type: 'packing_list', document_no: 'PL-AUTOST-2',
    items: [{ quantity: 480 }], total_amount: 480, currency: 'USD', status: 'completed', created_by: actorA,
  }).select('id').single()
  trash.push({ table: 'shipping_documents', id: ship2!.id })
  const { data: settled2 } = await svc.from('order_settlements').select('*').eq('budget_order_id', bo!.id)
  if (settled2?.length === 1) { ok(`幂等: 第二张 PL 不重复建（仍 1 张 settlement）`); pass++ }
  else bad(`幂等失败: 实际 ${settled2?.length} 张`)

  // ─── 3. auto_generated draft 不能由 system 自动 confirm（必须 settled_by） ───
  total++
  const settlementId = settled![0].id
  const { error: noHumanErr } = await svc.from('order_settlements').update({ status: 'confirmed' }).eq('id', settlementId)
  if (noHumanErr && /AUTO_SETTLEMENT_REQUIRES_HUMAN|settled_by/.test(noHumanErr.message)) {
    ok(`auto-settlement → confirmed 无 settled_by 被拒: ${noHumanErr.message.slice(0,60)}`); pass++
  } else bad(`P0：无人工签名也能 confirm！${noHumanErr?.message || '(成功)'}`)

  // ─── 4. 人工指定 settled_by → 允许 confirm ───
  total++
  const { error: humanErr } = await svc.from('order_settlements').update({
    status: 'confirmed', settled_by: actorB, settled_at: new Date().toISOString()
  }).eq('id', settlementId)
  if (!humanErr) { ok(`指定 settled_by 后 confirm 成功`); pass++ }
  else bad(`confirm 失败: ${humanErr.message}`)

  // ─── 5. 冻结订单 → ship 完结被拦截 ───
  total++
  // 新订单
  const { data: bo2 } = await svc.from('budget_orders').insert({
    order_no: 'AUTOST-FZ-' + Date.now(), customer_id: c!.id, created_by: actorA,
    order_date: '2026-05-16', delivery_date: '2026-05-16', items: [],
    total_revenue: 100, total_cost: 50, estimated_profit: 50, estimated_margin: 50,
    currency: 'CNY', exchange_rate: 1, status: 'approved',
  }).select('id').single()
  trash.push({ table: 'budget_orders', id: bo2!.id })

  // 冻结
  const { data: freeze } = await svc.from('entity_freezes').insert({
    entity_type: 'budget_order', entity_id: bo2!.id, entity_name: 'AUTOST-FZ',
    freeze_reason: 'auto-settlement test', freeze_type: 'manual',
    trigger_source: 'test', status: 'frozen',
    frozen_by: actorA, frozen_at: new Date().toISOString(),
  }).select('id').single()

  // ship 完结尝试 — INSERT shipping → trigger 触发 auto-settlement INSERT → freeze guard RAISE
  const { error: shipErr } = await svc.from('shipping_documents').insert({
    budget_order_id: bo2!.id, doc_type: 'packing_list', document_no: 'PL-FZ-1',
    items: [{ quantity: 10 }], total_amount: 10, currency: 'USD', status: 'completed', created_by: actorA,
  })
  // 既会被 shipping 自身的 freeze guard 拦截，也会被 settlement 创建时的 freeze guard 拦截
  if (shipErr && /FROZEN_ENTITY/.test(shipErr.message)) {
    ok(`冻结订单 → ship 完结被拦截（连带 auto-settlement 也无法建）`); pass++
  } else bad(`P0：冻结订单仍能完结发货！${shipErr?.message || '(成功)'}`)

  // 清解冻
  await svc.from('entity_freezes').update({
    status: 'unfrozen', unfrozen_by: actorB, unfrozen_at: new Date().toISOString(),
    unfreeze_reason: 'test 完成',
  }).eq('id', freeze!.id)
  await svc.from('entity_freezes').delete().eq('id', freeze!.id)

  // ─── 6. provenance 覆盖：order_settlements create 应有一行 ───
  total++
  const { data: prov } = await svc.from('financial_provenance')
    .select('actor_role, action_type, target_status_after, affected_reports')
    .eq('target_table', 'order_settlements').eq('target_id', settlementId)
    .order('created_at')
  if (prov && prov.length >= 2 && prov[0].action_type === 'create' && prov.some(p => p.action_type === 'status_change')) {
    ok(`provenance: settlement 链 ${prov.length} 条 (create + status_change confirmed)`); pass++
  } else bad(`provenance 链不完整: ${JSON.stringify(prov)}`)

  // ─── 7. save_diagnostic_logs 有 auto_create 记录 ───
  total++
  const { data: diag } = await svc.from('save_diagnostic_logs')
    .select('action, error_detail').eq('action', 'auto_create')
    .like('error_detail', `%${settlementId}%`).limit(1)
  if (diag?.length) { ok(`audit log: auto_create 记录已写入`); pass++ }
  else bad(`auto_create audit 缺失`)

  // ─── 清理 ───
  console.log()
  console.log('═══ 清理 ═══')
  await svc.from('save_diagnostic_logs').delete().like('error_detail', '%AUTOST-%')
  await svc.from('save_diagnostic_logs').delete().like('error_detail', `%${settlementId}%`)
  await svc.from('financial_provenance').delete().or(`target_id.eq.${settlementId},target_id.eq.${bo!.id},target_id.eq.${bo2!.id},target_id.eq.${ship1!.id},target_id.eq.${ship2!.id}`)
  for (const t of trash.reverse()) {
    const r = await hardDeleteForTest(svc, t.table, t.id, 'auto-settlement test cleanup')
    if (!r.deleted && r.error) console.log(`  ⚠ ${t.table}/${t.id.slice(0,8)}: ${r.error}`)
  }

  console.log()
  console.log(`总计: ${pass}/${total} 通过`)
  process.exit(pass === total ? 0 : 1)
})().catch(e => { console.error(e); process.exit(1) })
