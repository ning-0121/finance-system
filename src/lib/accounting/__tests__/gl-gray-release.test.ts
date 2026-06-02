import { describe, it, expect, beforeEach, vi } from 'vitest'

// freeze-engine 内部用浏览器 client，测试中 mock 为「未冻结」
vi.mock('@/lib/engines/freeze-engine', () => ({
  isEntityFrozen: vi.fn(async () => ({ frozen: false })),
}))
// retryQueueItem / enqueueAndProcess 用到 server client；用共享 mock 注入
let sharedDb: MockDb
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => sharedDb,
}))

import { getGlConfig, shouldAutoPost, requiresReview } from '../gl-config'
import {
  buildRevenueRecognition, buildCostRecognition, buildArReceipt, buildApPayment,
  classifyGlError, isBalanced, GlPostingError,
} from '../gl-journal-builders'
import { processQueueItem, retryQueueItem } from '../gl-queue'

// ════════════════ 纯逻辑：配置与决策 ════════════════
describe('GL 配置（试运行边界）', () => {
  const clear = () => { delete process.env.GL_AUTO_POST_ENABLED; delete process.env.GL_DRAFT_ONLY; delete process.env.GL_REVIEW_THRESHOLD_CNY }
  beforeEach(clear)

  it('默认：自动过账关闭、仅 draft、任何金额都需复核', () => {
    const cfg = getGlConfig()
    expect(cfg.autoPostEnabled).toBe(false)
    expect(cfg.draftOnly).toBe(true)
    expect(shouldAutoPost(1, cfg)).toBe(false)
    expect(shouldAutoPost(0.01, cfg)).toBe(false)
    expect(requiresReview(0.01, cfg)).toBe(true)
  })

  it('仅当 开关开启 + 非 draftOnly + 低于阈值 才允许自动过账', () => {
    process.env.GL_AUTO_POST_ENABLED = 'true'
    process.env.GL_DRAFT_ONLY = 'false'
    process.env.GL_REVIEW_THRESHOLD_CNY = '10000'
    const cfg = getGlConfig()
    expect(shouldAutoPost(9999, cfg)).toBe(true)   // 低风险 → 自动
    expect(shouldAutoPost(10000, cfg)).toBe(false) // 达到阈值 → 必须复核
    expect(shouldAutoPost(50000, cfg)).toBe(false) // 高金额 → 必须复核
  })

  it('开关开启但 draftOnly 仍开 → 不自动过账', () => {
    process.env.GL_AUTO_POST_ENABLED = 'true'
    process.env.GL_DRAFT_ONLY = 'true'
    process.env.GL_REVIEW_THRESHOLD_CNY = '999999'
    expect(shouldAutoPost(1, getGlConfig())).toBe(false)
  })
})

// ════════════════ 纯逻辑：构造器（缺汇率/平衡/溯源） ════════════════
describe('GL 凭证构造器', () => {
  const usdOrder = { id: 'o1', order_no: 'PO-1', customer_id: 'c1', customer_company: 'ACME', currency: 'USD', exchange_rate: null, total_revenue: 1000, order_date: '2026-06-01' }

  it('外币缺汇率 → 抛 MISSING_RATE（不套默认 7.0）', () => {
    expect(() => buildRevenueRecognition(usdOrder)).toThrowError(GlPostingError)
    try { buildRevenueRecognition(usdOrder) } catch (e) { expect((e as GlPostingError).code).toBe('MISSING_RATE') }
    expect(() => buildApPayment({ id: 'p1', supplier_name: 'S', amount: 100, currency: 'USD', exchange_rate: null }))
      .toThrowError(/MISSING_RATE|汇率/)
  })

  it('收入凭证：借贷平衡 + 完整 provenance（可追溯订单/客户/汇率来源/说明）', () => {
    const spec = buildRevenueRecognition({ ...usdOrder, exchange_rate: 7.2 })!
    expect(spec).not.toBeNull()
    expect(isBalanced(spec)).toBe(true)
    expect(spec.amountCny).toBe(7200)
    expect(spec.provenance.relatedOrderId).toBe('o1')
    expect(spec.provenance.relatedCustomerId).toBe('c1')
    expect(spec.provenance.exchangeRateSource).toContain('7.2')
    expect(spec.provenance.explanation).toBeTruthy()
    expect(spec.businessEvent).toBe('order_approved')
    expect(spec.sourceType).toBe('budget_order')
    expect(spec.sourceId).toBe('o1')
  })

  it('CNY 收入：汇率=1，金额即原值', () => {
    const spec = buildRevenueRecognition({ ...usdOrder, currency: 'CNY', exchange_rate: 1 })!
    expect(spec.amountCny).toBe(1000)
    expect(isBalanced(spec)).toBe(true)
  })

  it('成本凭证：各科目合计=应付贷方，平衡', () => {
    const spec = buildCostRecognition({
      id: 'o1', order_no: 'PO-1', order_date: '2026-06-01', currency: 'CNY', exchange_rate: 1,
      fabric: 500, accessory: 100, processing: 200, forwarder: 50, container: 30, logistics: 20, extras: [{ name: '税', amount: 10 }],
    })!
    expect(isBalanced(spec)).toBe(true)
    expect(spec.amountCny).toBe(910)
    expect(spec.provenance.relatedOrderId).toBe('o1')
  })

  it('回款差额≤0 → 返回 null（幂等，重复保存不重复入账）', () => {
    const order = { ...usdOrder, currency: 'CNY', exchange_rate: 1 }
    expect(buildArReceipt({ order, amountCnyDelta: 0 })).toBeNull()
    expect(buildArReceipt({ order, amountCnyDelta: -5 })).toBeNull()
    const spec = buildArReceipt({ order, amountCnyDelta: 300 })!
    expect(spec.amountCny).toBe(300)
    expect(isBalanced(spec)).toBe(true)
  })

  it('错误分类：RPC 文本 → 失败类型码', () => {
    expect(classifyGlError(new Error('PERIOD_CLOSED: 2026-05 已关闭'))).toBe('PERIOD_CLOSED')
    expect(classifyGlError(new Error('UNBALANCED: ...'))).toBe('UNBALANCED')
    expect(classifyGlError(new Error('violates foreign key constraint on account_code'))).toBe('ACCOUNT_MISSING')
    expect(classifyGlError(new GlPostingError('FREEZE_BLOCKED', 'x'))).toBe('FREEZE_BLOCKED')
  })
})

// ════════════════ 集成：processQueueItem（含 mock DB） ════════════════
type Row = Record<string, unknown>
interface MockDb {
  from: (t: string) => unknown
  rpc: (n: string, a: Row) => Promise<{ data: unknown; error: { message: string } | null }>
  _rpc: { name: string; args: Row }[]
  _updates: { table: string; row: Row }[]
  _inserts: { table: string; row: Row }[]
}

function makeDb(cfg: {
  queueItem?: Row
  order?: Row | null
  payment?: Row | null
  dedup?: Row[]          // journal_entries dedup 结果
  priorReceipts?: Row[]  // 回款已入账
  draftRpc?: { data?: Row; error?: { message: string } | null }
  postRpc?: { data?: Row; error?: { message: string } | null }
  findingExisting?: Row[]
}): MockDb {
  const _rpc: { name: string; args: Row }[] = []
  const _updates: { table: string; row: Row }[] = []
  const _inserts: { table: string; row: Row }[] = []
  let draftCall = 0

  function builder(table: string) {
    const st: { table: string; op: string; cols?: string; limited?: boolean } = { table, op: 'select' }
    const b: Record<string, unknown> = {}
    const list = () => {
      if (table === 'gl_posting_queue') return { data: cfg.queueItem ? [cfg.queueItem] : [], error: null }
      if (table === 'journal_entries') {
        if (st.limited) return { data: cfg.dedup ?? [], error: null }       // dedup 查询带 limit
        return { data: cfg.priorReceipts ?? [], error: null }               // 回款 prior 查询无 limit
      }
      if (table === 'audit_findings') return { data: cfg.findingExisting ?? [], error: null }
      return { data: [], error: null }
    }
    const single = () => {
      if (table === 'gl_posting_queue') return { data: cfg.queueItem ?? null, error: null }
      if (table === 'budget_orders') return { data: cfg.order ?? null, error: null }
      if (table === 'supplier_payments') return { data: cfg.payment ?? null, error: null }
      return { data: null, error: null }
    }
    Object.assign(b, {
      select(c?: string) { st.cols = c; return b },
      insert(row: Row) { st.op = 'insert'; _inserts.push({ table, row }); return b },
      update(row: Row) { st.op = 'update'; _updates.push({ table, row }); return b },
      eq() { return b }, in() { return b }, is() { return b }, or() { return b }, order() { return b },
      limit() { st.limited = true; return Promise.resolve(list()) },
      single() { return Promise.resolve(single()) },
      then(res: (v: unknown) => unknown) { return Promise.resolve(list()).then(res) },
    })
    return b
  }

  return {
    from: (t: string) => builder(t),
    rpc: (name: string, args: Row) => {
      _rpc.push({ name, args })
      if (name === 'create_journal_draft') {
        draftCall++
        // 支持「首次失败、重试成功」：draftRpc.error 仅作用于第一次
        if (cfg.draftRpc?.error && draftCall === 1) return Promise.resolve({ data: null, error: cfg.draftRpc.error })
        return Promise.resolve({ data: cfg.draftRpc?.data ?? { journal_id: 'J1', voucher_no: 'PZ-1' }, error: null })
      }
      if (name === 'post_journal') return Promise.resolve({ data: cfg.postRpc?.data ?? { status: 'posted' }, error: cfg.postRpc?.error ?? null })
      return Promise.resolve({ data: null, error: null })
    },
    _rpc, _updates, _inserts,
  }
}

const baseQueue = (event: string, extra: Row = {}) => ({
  id: 'q1', source_type: event === 'payment_registered' ? 'supplier_payment' : event === 'settlement_confirmed' ? 'settlement' : 'budget_order',
  source_id: 's1', business_event: event, target_journal_type: 'x', status: 'pending', attempts: 0, created_by: 'u1', ...extra,
})

describe('processQueueItem 灰度行为', () => {
  beforeEach(() => { delete process.env.GL_AUTO_POST_ENABLED; delete process.env.GL_DRAFT_ONLY; delete process.env.GL_REVIEW_THRESHOLD_CNY })

  it('T1 默认配置：审批通过只生成 draft，不 posted', async () => {
    const db = makeDb({
      queueItem: baseQueue('order_approved'),
      order: { id: 's1', order_no: 'PO-1', customer_id: 'c1', currency: 'CNY', exchange_rate: 1, total_revenue: 1000, order_date: '2026-06-01', customers: { company: 'ACME' } },
      dedup: [],
    })
    const r = await processQueueItem(db as never, 'q1', 'u1')
    expect(r.status).toBe('draft_created')
    expect(db._rpc.some(c => c.name === 'create_journal_draft')).toBe(true)
    expect(db._rpc.some(c => c.name === 'post_journal')).toBe(false)  // 关键：默认不 posted
    const upd = db._updates.find(u => u.table === 'gl_posting_queue' && u.row.status === 'draft_created')
    expect(upd?.row.requires_review).toBe(true)
  })

  it('T2 缺汇率：失败入异常中心，不生成凭证', async () => {
    const db = makeDb({
      queueItem: baseQueue('order_approved'),
      order: { id: 's1', order_no: 'PO-1', customer_id: 'c1', currency: 'USD', exchange_rate: null, total_revenue: 1000, order_date: '2026-06-01', customers: { company: 'ACME' } },
    })
    const r = await processQueueItem(db as never, 'q1', 'u1')
    expect(r.status).toBe('failed')
    expect(r.code).toBe('MISSING_RATE')
    expect(db._rpc.some(c => c.name === 'create_journal_draft')).toBe(false) // 不生成错误凭证
    expect(db._inserts.some(i => i.table === 'audit_findings')).toBe(true)   // 进异常中心
    expect(db._updates.some(u => u.table === 'gl_posting_queue' && u.row.status === 'failed')).toBe(true)
  })

  it('T3 会计期间关闭：进 failed，不影响业务（处理器不碰业务表）', async () => {
    const db = makeDb({
      queueItem: baseQueue('order_approved'),
      order: { id: 's1', order_no: 'PO-1', customer_id: 'c1', currency: 'CNY', exchange_rate: 1, total_revenue: 1000, order_date: '2026-05-01', customers: { company: 'ACME' } },
      dedup: [],
      draftRpc: { error: { message: 'PERIOD_CLOSED: 会计期间 2026-05 已关闭' } },
    })
    const r = await processQueueItem(db as never, 'q1', 'u1')
    expect(r.status).toBe('failed')
    expect(r.code).toBe('PERIOD_CLOSED')
    expect(db._inserts.some(i => i.table === 'audit_findings')).toBe(true)
  })

  it('T4 同源重复触发：去重跳过，不重复生成凭证', async () => {
    const db = makeDb({
      queueItem: baseQueue('order_approved'),
      order: { id: 's1', order_no: 'PO-1', customer_id: 'c1', currency: 'CNY', exchange_rate: 1, total_revenue: 1000, order_date: '2026-06-01', customers: { company: 'ACME' } },
      dedup: [{ id: 'J-existing' }],  // 已存在同源 draft/posted
    })
    const r = await processQueueItem(db as never, 'q1', 'u1')
    expect(r.status).toBe('skipped')
    expect(db._rpc.some(c => c.name === 'create_journal_draft')).toBe(false)
  })

  it('T5 开关+低风险：自动过账（验证仅在显式低风险配置下才 posted）', async () => {
    process.env.GL_AUTO_POST_ENABLED = 'true'
    process.env.GL_DRAFT_ONLY = 'false'
    process.env.GL_REVIEW_THRESHOLD_CNY = '1000000'
    const db = makeDb({
      queueItem: baseQueue('order_approved'),
      order: { id: 's1', order_no: 'PO-1', customer_id: 'c1', currency: 'CNY', exchange_rate: 1, total_revenue: 1000, order_date: '2026-06-01', customers: { company: 'ACME' } },
      dedup: [],
    })
    const r = await processQueueItem(db as never, 'q1', 'u1')
    expect(r.status).toBe('posted')
    expect(db._rpc.some(c => c.name === 'post_journal')).toBe(true)
  })

  it('T7 溯源互通：draft 带 posting_queue_id+related_order_id，队列回填 journal_id', async () => {
    const db = makeDb({
      queueItem: baseQueue('order_approved'),
      order: { id: 's1', order_no: 'PO-1', customer_id: 'c1', currency: 'CNY', exchange_rate: 1, total_revenue: 1000, order_date: '2026-06-01', customers: { company: 'ACME' } },
      dedup: [],
    })
    await processQueueItem(db as never, 'q1', 'u1')
    const draft = db._rpc.find(c => c.name === 'create_journal_draft')!
    expect(draft.args.p_posting_queue_id).toBe('q1')   // 凭证 → 队列
    expect(draft.args.p_related_order_id).toBe('s1')
    expect(draft.args.p_source_id).toBe('s1')
    const upd = db._updates.find(u => u.table === 'gl_posting_queue' && u.row.journal_id)
    expect(upd?.row.journal_id).toBe('J1')             // 队列 → 凭证
  })
})

describe('retryQueueItem', () => {
  beforeEach(() => { delete process.env.GL_AUTO_POST_ENABLED; delete process.env.GL_DRAFT_ONLY; delete process.env.GL_REVIEW_THRESHOLD_CNY })

  it('T6 过账失败后手动重试：首次 RPC 失败→failed，重试成功→draft_created 并标记异常 resolved', async () => {
    const db = makeDb({
      queueItem: baseQueue('order_approved'),
      order: { id: 's1', order_no: 'PO-1', customer_id: 'c1', currency: 'CNY', exchange_rate: 1, total_revenue: 1000, order_date: '2026-06-01', customers: { company: 'ACME' } },
      dedup: [],
      draftRpc: { error: { message: 'RPC_FAILED: 临时故障' } }, // 仅第一次失败
      findingExisting: [{ id: 'f1' }],
    })
    sharedDb = db
    const first = await processQueueItem(db as never, 'q1', 'u1')
    expect(first.status).toBe('failed')
    const retry = await retryQueueItem('q1', 'u1')
    expect(retry.status).toBe('draft_created')
    // 重试成功 → 关闭异常
    expect(db._updates.some(u => u.table === 'audit_findings' && u.row.status === 'resolved')).toBe(true)
  })
})
