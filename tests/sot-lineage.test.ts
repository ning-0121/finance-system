/**
 * Phase A-1 SoT lineage helper — unit tests
 * Run: npx tsx tests/sot-lineage.test.ts
 *
 * 这些是纯逻辑测试，不需要真实 Supabase。
 * 通过 _setTestImplementations() 注入 mock client，验证：
 *   1. sotWriteShadow 在 supabase 抛错时不抛
 *   2. sotWriteShadow 在 RPC error 返回时不抛
 *   3. getLineage 在 error 时返回 null
 *   4. getLineageHistory 在 error 时返回 []
 *   5. RPC 参数映射正确
 *
 * 数据库联调测试（真实 RPC 调用）见 A-1-verify.sql。
 */

import {
  sotWriteShadow,
  getLineage,
  getLineageHistory,
  _setTestImplementations,
  _resetTestImplementations,
} from '../src/lib/sot/lineage'

// ─── Mock state ──────────────────────────────────────────────────────────────

interface MockState {
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>
  rpcResponse: { data?: unknown; error?: { message: string } | null }
  selectResponse: { data?: unknown; error?: { message: string } | null }
  shouldThrow: boolean
}

const state: MockState = {
  rpcCalls: [],
  rpcResponse: { data: 'fake-lineage-id', error: null },
  selectResponse: { data: null, error: null },
  shouldThrow: false,
}

function resetState() {
  state.rpcCalls = []
  state.rpcResponse = { data: 'fake-lineage-id', error: null }
  state.selectResponse = { data: null, error: null }
  state.shouldThrow = false
}

// 链式 mock —— client 与 query builder 必须分开，
// 因为 supabase 的 query builder 是 thenable（await 触发执行），
// 而 client 不能是 thenable，否则 `await createClient()` 会被错误拆包。

// query builder（thenable）：所有链式方法返回自身，await 时返回 selectResponse
function makeQueryBuilder() {
  // 使用 unknown 避免 Record 索引签名与 then 类型冲突
  const qb = {
    select:      () => qb,
    eq:          () => qb,
    order:       () => qb,
    limit:       () => qb,
    maybeSingle: () => {
      if (state.shouldThrow) return Promise.reject(new Error('boom'))
      return Promise.resolve(state.selectResponse)
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.shouldThrow) return Promise.reject(new Error('boom')).catch(resolve)
      return Promise.resolve(state.selectResponse).then(resolve)
    },
  }
  return qb
}

// schema builder（不是 thenable）：rpc 返回 promise；from 返回 query builder
function makeSchemaBuilder() {
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (state.shouldThrow) return Promise.reject(new Error('boom'))
      state.rpcCalls.push({ name, args })
      return Promise.resolve(state.rpcResponse)
    },
    from: () => makeQueryBuilder(),
  }
}

// client（不是 thenable）：仅 schema()
function makeMockClient() {
  return {
    schema: () => makeSchemaBuilder(),
  }
}

// 注入 mock —— client 是非 thenable 对象，await 后保持原样
_setTestImplementations({
  createClient: (async () => makeMockClient()) as never,
  getCurrentTenantId: async () => 'test-tenant-uuid',
})

// ─── Test framework ─────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ ${label}`)
    failed++
  }
}

function section(t: string) { console.log(`\n── ${t} ──`) }

// ─── Tests ──────────────────────────────────────────────────────────────────

async function run() {
  // 1. 成功写入
  section('sotWriteShadow — happy path')
  resetState()
  const r1 = await sotWriteShadow({
    table: 'budget_orders',
    rowId: '00000000-0000-0000-0000-000000000001',
    field: 'total_revenue',
    value: 65000,
    sourceType: 'derived',
    sourceEntity: 'styles_aggregation',
    confidence: 1.0,
    actorId: 'user-1',
    actorRole: 'finance_manager',
    context: { reason: 'recompute' },
  })
  assert(r1.ok === true, 'returns ok=true on success')
  assert(r1.lineageId === 'fake-lineage-id', 'returns lineageId from RPC')
  assert(state.rpcCalls.length === 1, 'calls RPC exactly once')
  assert(state.rpcCalls[0]?.name === 'shadow_write', 'calls correct RPC name')

  const args = state.rpcCalls[0]!.args
  assert(args.p_target_table === 'budget_orders', 'maps table → p_target_table')
  assert(args.p_target_field === 'total_revenue', 'maps field → p_target_field')
  assert(args.p_source_type === 'derived', 'maps sourceType → p_source_type')
  assert(args.p_confidence === 1.0, 'maps confidence → p_confidence')
  assert(args.p_actor_id === 'user-1', 'maps actorId → p_actor_id')
  assert(args.p_tenant_id === 'test-tenant-uuid', 'auto-fills tenant id')
  assert(args.p_target_field_value === 65000, 'passes value as is')

  // 2. RPC error
  section('sotWriteShadow — RPC returns error')
  resetState()
  state.rpcResponse = { data: null, error: { message: 'duplicate key violation' } }
  const r2 = await sotWriteShadow({
    table: 'x', rowId: 'y', field: 'z', value: null,
    sourceType: 'manual_entry',
  })
  assert(r2.ok === false, 'returns ok=false')
  assert(r2.error === 'duplicate key violation', 'surfaces error message')

  // 3. 底层抛错时不冒泡
  section('sotWriteShadow — supabase throws (must not propagate)')
  resetState()
  state.shouldThrow = true
  let didThrow = false
  let r3: Awaited<ReturnType<typeof sotWriteShadow>> | null = null
  try {
    r3 = await sotWriteShadow({
      table: 'x', rowId: 'y', field: 'z', value: 1,
      sourceType: 'manual_entry',
    })
  } catch {
    didThrow = true
  }
  assert(didThrow === false, 'never throws to caller')
  assert(r3?.ok === false, 'returns ok=false on throw')
  assert(typeof r3?.error === 'string', 'returns error message')

  // 4. 默认值
  section('sotWriteShadow — defaults')
  resetState()
  await sotWriteShadow({
    table: 't', rowId: 'r', field: 'f', value: null,
    sourceType: 'manual_entry',
  })
  const a4 = state.rpcCalls[0]!.args
  assert(a4.p_confidence === 1.0, 'default confidence = 1.0')
  assert(a4.p_allow_manual_override === true, 'default allow_manual_override = true')
  assert(a4.p_action === 'sot_shadow_write', 'default action = sot_shadow_write')
  assert(a4.p_actor_id === null, 'default actor_id = null')
  assert(a4.p_source_entity === null, 'default source_entity = null')

  // 5. tenant 缺失时返回 ok=false 不抛
  section('sotWriteShadow — missing tenant id')
  resetState()
  _setTestImplementations({ getCurrentTenantId: async () => null })
  const r5 = await sotWriteShadow({
    table: 't', rowId: 'r', field: 'f', value: 1,
    sourceType: 'manual_entry',
  })
  assert(r5.ok === false, 'returns ok=false when tenant missing')
  assert(r5.error === 'no tenant id available', 'error message correct')
  assert(state.rpcCalls.length === 0, 'no RPC call attempted')
  // 恢复 tenant impl
  _setTestImplementations({ getCurrentTenantId: async () => 'test-tenant-uuid' })

  // 6. getLineage — not found
  section('getLineage — not found returns null')
  resetState()
  state.selectResponse = { data: null, error: null }
  const lineage6 = await getLineage('budget_orders', 'r-1', 'total_revenue')
  assert(lineage6 === null, 'returns null when no row')

  // 7. getLineage — error returns null
  section('getLineage — error returns null (not throw)')
  resetState()
  state.selectResponse = { data: null, error: { message: 'permission denied' } }
  let lThrew = false
  let l7: Awaited<ReturnType<typeof getLineage>> = undefined as never
  try {
    l7 = await getLineage('budget_orders', 'r-1', 'total_revenue')
  } catch {
    lThrew = true
  }
  assert(!lThrew, 'getLineage never throws')
  assert(l7 === null, 'returns null on error')

  // 8. getLineage — happy path
  section('getLineage — happy path')
  resetState()
  state.selectResponse = {
    data: {
      id: 'fl-1',
      tenant_id: 'test-tenant-uuid',
      target_table: 'budget_orders',
      target_row_id: 'r-1',
      target_field: 'total_revenue',
      target_field_value: 65000,
      source_type: 'derived',
      source_entity: 'styles_aggregation',
      source_document_id: null,
      source_field: null,
      confidence: 1.0,
      last_verified_at: '2026-04-27T00:00:00Z',
      verified_by: null,
      allow_manual_override: true,
      override_reason: null,
      audit_event_id: 'ae-1',
      is_current: true,
      superseded_by: null,
      created_at: '2026-04-27T00:00:00Z',
      updated_at: '2026-04-27T00:00:00Z',
    },
    error: null,
  }
  const l8 = await getLineage('budget_orders', 'r-1', 'total_revenue')
  assert(l8 !== null, 'returns data when found')
  assert(l8?.source_type === 'derived', 'data structure correct')

  // 9. getLineageHistory — error returns []
  section('getLineageHistory — error returns empty array')
  resetState()
  state.selectResponse = { data: null, error: { message: 'oops' } }
  const h9 = await getLineageHistory('budget_orders', 'r-1')
  assert(Array.isArray(h9), 'returns array')
  assert(h9.length === 0, 'returns empty on error')

  // 10. getLineageHistory — happy path
  section('getLineageHistory — returns array')
  resetState()
  state.selectResponse = {
    data: [
      { id: 'fl-2', target_field: 'total_revenue', is_current: true, source_type: 'derived' },
      { id: 'fl-1', target_field: 'total_revenue', is_current: false, source_type: 'manual_entry' },
    ],
    error: null,
  }
  const h10 = await getLineageHistory('budget_orders', 'r-1', 'total_revenue')
  assert(h10.length === 2, 'returns all rows')
  assert(h10[0].id === 'fl-2', 'preserves order from DB')

  // Cleanup
  _resetTestImplementations()

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('\n❌ Some tests failed!')
    process.exit(1)
  } else {
    console.log('\n✅ All tests passed!')
  }
}

run().catch(e => { console.error('Test runner crashed:', e); process.exit(1) })
