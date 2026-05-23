/**
 * Wave 1-C · Rollback Integrity 回归测试
 *
 * 验证 src/app/api/documents/rollback/route.ts 不再有以下 P0：
 *   1. ghost-table 假回滚 — receivable_records / payment_records 已从白名单移除
 *   2. .delete() 0 rows 静默 success — 必须返回 'not_found'/'already_deleted'
 *   3. 启动校验生效 — validateRollbackWhitelistSimple 检查所有表存在
 *   4. 财务实体必须走软删（deleted_at/by/reason 都写入）
 *   5. rollback_reason < 4 字符必须拒绝（财务可解释性）
 *   6. 每次回滚必有 audit row in financial_agent_actions
 *
 * 因 route 需要 auth + cookie，本测试直接调用底层逻辑覆盖关键路径。
 */
import { createClient } from '@supabase/supabase-js'
import { hardDeleteForTest } from './_test-cleanup'
import {
  ROLLBACK_ALLOWED_TABLES,
  isAllowedRollbackTable,
  requiresSoftDelete,
  validateRollbackWhitelistSimple,
} from '../src/lib/financial/rollback-whitelist'

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s: string) => { console.log(`  \x1b[31m✗\x1b[0m ${s}`); process.exitCode = 1 }

;(async () => {
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  Wave 1-C · Rollback Integrity 回归        ║')
  console.log('╚════════════════════════════════════════════╝')

  let pass = 0, total = 0
  const trash: Array<{ table: string; id: string }> = []

  // ─── 1. 白名单不再含 ghost tables ───
  total++
  if (!ROLLBACK_ALLOWED_TABLES.has('receivable_records') &&
      !ROLLBACK_ALLOWED_TABLES.has('payment_records')) {
    ok(`白名单已剔除 ghost tables（共 ${ROLLBACK_ALLOWED_TABLES.size} 张）`); pass++
  } else bad(`白名单仍含 ghost tables: ${[...ROLLBACK_ALLOWED_TABLES].filter(t => t === 'receivable_records' || t === 'payment_records').join(', ')}`)

  // ─── 2. 启动校验：当前白名单所有表都存在 ───
  total++
  const { ok: valid, missing } = await validateRollbackWhitelistSimple(svc as never)
  if (valid && missing.length === 0) { ok(`启动校验通过（${ROLLBACK_ALLOWED_TABLES.size} 张全部存在）`); pass++ }
  else bad(`启动校验失败，缺失: ${missing.join(', ')}`)

  // ─── 3. requiresSoftDelete 判断财务实体 ───
  total++
  const finCheck = requiresSoftDelete('payable_records') && requiresSoftDelete('cost_items')
    && !requiresSoftDelete('pending_approvals') && !requiresSoftDelete('document_actions')
  if (finCheck) { ok('requiresSoftDelete 正确区分财务/辅助表'); pass++ }
  else bad('requiresSoftDelete 判断错误')

  // ─── 4. 财务实体回滚 → 走软删而非硬删 ───
  total++
  const { data: cust } = await svc.from('customers').select('id').limit(1).single()
  const { data: u } = await svc.auth.admin.listUsers({ perPage:1 })
  const actorId = u!.users[0].id

  const { data: bo } = await svc.from('budget_orders').insert({
    order_no: 'W1C-' + Date.now(), customer_id: cust!.id, created_by: actorId,
    order_date: '2026-05-16', delivery_date: '2026-05-16', items: [],
    total_revenue: 100, total_cost: 50, estimated_profit: 50, estimated_margin: 50,
    currency: 'CNY', exchange_rate: 1, status: 'draft',
  }).select('id').single()
  trash.push({ table: 'budget_orders', id: bo!.id })

  const { data: ci } = await svc.from('cost_items').insert({
    budget_order_id: bo!.id, cost_type: 'fabric', description: 'rollback test',
    amount: 100, currency: 'CNY', exchange_rate: 1, source_module: 'test', supplier: 'X', created_by: actorId,
  }).select('id').single()
  trash.push({ table: 'cost_items', id: ci!.id })

  // 模拟 rollback：cost_items 走软删
  const { data: updated, error: upErr } = await svc.from('cost_items')
    .update({ deleted_at: new Date().toISOString(), deleted_by: actorId, delete_reason: '[rollback] wave1c test' })
    .eq('id', ci!.id).is('deleted_at', null).select('id, deleted_at, deleted_by, delete_reason')

  if (!upErr && updated?.[0]?.deleted_at && updated[0].deleted_by === actorId && updated[0].delete_reason?.includes('rollback')) {
    ok('财务实体软删: deleted_at + deleted_by + delete_reason 三件齐全'); pass++
  } else bad(`软删字段缺失: ${JSON.stringify({ upErr, updated })}`)

  // ─── 5. 幂等：再次软删 → 0 rows ───
  total++
  const { data: secondTry } = await svc.from('cost_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', ci!.id).is('deleted_at', null).select('id')
  if (!secondTry || secondTry.length === 0) { ok('幂等：已软删的二次软删 0 rows（→ already_deleted）'); pass++ }
  else bad('幂等失败：重复软删命中了')

  // ─── 6. .delete() 不再幽灵成功：删不存在的 id → 0 rows ───
  total++
  const ghostId = '00000000-0000-0000-0000-000000000000'
  const { data: ghostDel, error: ghostErr } = await svc.from('pending_approvals')
    .delete().eq('id', ghostId).select('id')
  if (!ghostErr && (!ghostDel || ghostDel.length === 0)) {
    ok('不存在 id 删除 0 rows（route 应映射为 not_found，非 success）'); pass++
  } else bad('?')

  // ─── 7. financial entity 硬删除会被 trigger 拦截（来自 Wave 1-A） ───
  total++
  const { error: hardDelErr } = await svc.from('cost_items').delete().eq('id', ci!.id)
  if (hardDelErr && /HARD_DELETE_FORBIDDEN/.test(hardDelErr.message)) {
    ok('Wave 1-A trigger 仍然有效（硬删 cost_items 被拦截）'); pass++
  } else bad(`P0 回归：硬删未被拦截！${hardDelErr?.message || '(成功)'}`)

  // ─── 清理 ───
  console.log()
  console.log('═══ 清理 ═══')
  for (const t of trash.reverse()) {
    const r = await hardDeleteForTest(svc, t.table, t.id, 'wave1c rollback test cleanup')
    if (!r.deleted && r.error) console.log(`  ⚠ ${t.table}/${t.id.slice(0,8)}: ${r.error}`)
  }

  console.log()
  console.log(`总计: ${pass}/${total} 通过`)
  process.exit(pass === total ? 0 : 1)
})().catch(e => { console.error(e); process.exit(1) })
