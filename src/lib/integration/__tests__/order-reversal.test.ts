import { describe, it, expect, vi } from 'vitest'

// preflightOrderVoid 走真实 server client;测试里固定为「干净单」,
// 只验证本模块的保守冲销规则(作废队列分支另测)。
vi.mock('@/lib/financial/order-void', () => ({
  preflightOrderVoid: vi.fn(async () => ({
    severity: 'clean', items: [], orderNo: 'BO-1', qmOrderNo: 'QM-1', internalNo: '1001',
  })),
}))

import { reverseOrder, isDeadLifecycle } from '../order-reversal'
import type { SyncedOrder } from '../types'

// ── 极简 supabase 桩:按表名返回预置数据,并记录所有 update ──
type Rec = Record<string, unknown>
function makeDb(tables: Record<string, Rec[]>) {
  const updates: { table: string; payload: Rec }[] = []
  const inserts: { table: string; payload: Rec }[] = []
  const client = {
    from(table: string) {
      const q: Rec = {}
      const self = {
        select: () => self, eq: () => self, is: () => self, in: () => self,
        contains: () => self, limit: () => self, order: () => self,
        maybeSingle: async () => ({ data: (tables[table] || [])[0] ?? null, error: null }),
        single: async () => ({ data: (tables[table] || [])[0] ?? null, error: null }),
        update(payload: Rec) { updates.push({ table, payload }); return { ...self, select: () => ({ ...self, then: undefined }) } },
        insert(payload: Rec) { inserts.push({ table, payload }); return self },
        then(res: (v: { data: Rec[]; error: null }) => unknown) { return Promise.resolve({ data: tables[table] || [], error: null }).then(res) },
      }
      Object.assign(self, q)
      return self
    },
  }
  return { client: client as never, updates, inserts }
}

const ORDER = { id: 'o-1', order_no: 'QM-1', lifecycle_status: 'cancelled' } as unknown as SyncedOrder

describe('isDeadLifecycle —— 中英文两种写法都要认', () => {
  it('死单', () => {
    for (const s of ['cancelled', 'deleted', '已取消', '已删除']) expect(isDeadLifecycle(s)).toBe(true)
  })
  it('活单/空值不算死', () => {
    for (const s of ['active', 'draft', '', null, undefined]) expect(isDeadLifecycle(s)).toBe(false)
  })
})

describe('reverseOrder —— 保守冲销口径', () => {
  it('草稿预算 → 自动作废(soft-delete),不碰其他', async () => {
    const { client, updates } = makeDb({
      synced_orders: [{ budget_order_id: 'b-1' }],
      budget_orders: [{ id: 'b-1', status: 'draft', deleted_at: null }],
      payable_records: [], fin_purchase_orders: [], pending_approvals: [],
    })
    const r = await reverseOrder(client, ORDER, 'order.cancelled')
    const bo = updates.find(u => u.table === 'budget_orders')
    expect(bo).toBeDefined()
    expect(bo!.payload.deleted_at).toBeTruthy()
    expect(String(bo!.payload.delete_reason)).toContain('取消')
    expect(r.actions.join()).toContain('预算草稿已作废')
  })

  it('已确认(非草稿)预算 → 绝不自动改账,只出警告', async () => {
    const { client, updates } = makeDb({
      synced_orders: [{ budget_order_id: 'b-1' }],
      budget_orders: [{ id: 'b-1', status: 'approved', deleted_at: null }],
      payable_records: [], fin_purchase_orders: [], pending_approvals: [],
    })
    const r = await reverseOrder(client, ORDER, 'order.cancelled')
    expect(updates.find(u => u.table === 'budget_orders')).toBeUndefined()   // 一个字都没改
    expect(r.warnings.join()).toContain('非草稿')
    expect(r.warnings.join()).toContain('未自动改账')
  })

  it('已软删的预算 → 幂等,不重复作废', async () => {
    const { client, updates } = makeDb({
      synced_orders: [{ budget_order_id: 'b-1' }],
      budget_orders: [{ id: 'b-1', status: 'draft', deleted_at: '2026-01-01T00:00:00Z' }],
      payable_records: [], fin_purchase_orders: [], pending_approvals: [],
    })
    await reverseOrder(client, ORDER, 'order.cancelled')
    expect(updates.find(u => u.table === 'budget_orders')).toBeUndefined()
  })

  it('未决采购单 → 自动撤销;已批/已付 → 只警告不动钱', async () => {
    const { client, updates } = makeDb({
      synced_orders: [{ budget_order_id: null }],
      budget_orders: [], payable_records: [], pending_approvals: [],
      fin_purchase_orders: [
        { id: 'p-1', po_no: 'PO-1', fin_status: 'pending_approval' },
        { id: 'p-2', po_no: 'PO-2', fin_status: 'paid' },
      ],
    })
    const r = await reverseOrder(client, ORDER, 'order.cancelled')
    const po = updates.find(u => u.table === 'fin_purchase_orders')
    expect(po).toBeDefined()
    expect(po!.payload.deleted_at).toBeTruthy()          // 未决的被撤
    expect(r.warnings.join()).toContain('已批/已付')      // 已付的只警告
    expect(r.warnings.join()).toContain('人工红冲')
  })

  it('预算作废后仍挂着费用归集 → 报警告等人工,不自动删改(审计 2026-08-03:21 行孤儿费用)', async () => {
    const { client, updates } = makeDb({
      synced_orders: [{ budget_order_id: 'b-1' }],
      budget_orders: [{ id: 'b-1', status: 'draft', deleted_at: null }],
      payable_records: [],
      cost_items: [{ amount: 618 }, { amount: -2000 }, { amount: 163.2 }],
      fin_purchase_orders: [], pending_approvals: [],
    })
    const r = await reverseOrder(client, ORDER, 'order.cancelled')
    expect(r.warnings.join()).toContain('3 行费用归集')
    expect(r.warnings.join()).toContain('-1218.8')      // 净额(含定金冲抵)如实报出
    expect(r.warnings.join()).toContain('未自动改')
    expect(updates.find(u => u.table === 'cost_items')).toBeUndefined()   // 一行都没动
  })

  it('同步侧调用 → 留痕写「定时同步」,与 webhook 区分得开', async () => {
    const { client, updates } = makeDb({
      synced_orders: [{ budget_order_id: 'b-1' }],
      budget_orders: [{ id: 'b-1', status: 'draft', deleted_at: null }],
      payable_records: [], fin_purchase_orders: [], pending_approvals: [],
    })
    await reverseOrder(client, ORDER, 'sync.cancelled')
    const bo = updates.find(u => u.table === 'budget_orders')
    expect(String(bo!.payload.delete_reason)).toContain('定时同步')
  })

  it('删除事件 → 文案用「删除」而非「取消」', async () => {
    const { client, updates } = makeDb({
      synced_orders: [{ budget_order_id: 'b-1' }],
      budget_orders: [{ id: 'b-1', status: 'draft', deleted_at: null }],
      payable_records: [], fin_purchase_orders: [], pending_approvals: [],
    })
    await reverseOrder(client, { ...ORDER, lifecycle_status: 'deleted' } as SyncedOrder, 'order.deleted')
    const bo = updates.find(u => u.table === 'budget_orders')
    expect(String(bo!.payload.delete_reason)).toContain('删除')
  })
})
