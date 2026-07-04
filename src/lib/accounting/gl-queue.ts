// ============================================================
// GL 过账队列处理器（服务端）
//
// 业务事件只「入队」(enqueueGlPosting)，不直接过账；
// 处理器 (processQueueItem) 负责：取数 → 构造凭证 → 去重 → freeze 检查
//   → 默认生成 draft（requires_review）→ 仅低风险且开关开启时自动 post。
//
// 任何失败：写入异常中心(audit_findings) + 审计日志(entity_timeline)，
//   队列置 failed + 安排重试，绝不抛回业务、绝不静默吞掉。
// ============================================================

import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isEntityFrozen } from '@/lib/engines/freeze-engine'
import { getGlConfig, shouldAutoPost, requiresReview } from './gl-config'
import {
  GlPostingError, classifyGlError, isBalanced,
  buildRevenueRecognition, buildCostRecognition, buildArReceipt, buildApPayment,
  bankAccountForCurrency,
  type JournalSpec, type SpecLine, type GlErrorCode,
} from './gl-journal-builders'

type DB = SupabaseClient

export type BusinessEvent = 'order_approved' | 'settlement_confirmed' | 'receipt_saved' | 'payment_registered'

export interface EnqueueParams {
  businessEvent: BusinessEvent
  sourceType: string
  sourceId: string
  createdBy?: string | null
  bankCode?: string | null
  bankName?: string | null
}

const RETRY_BACKOFF_MIN = [1, 5, 30, 120, 720] // 分钟：1m,5m,30m,2h,12h

function backoffIso(attempts: number): string {
  const idx = Math.min(attempts, RETRY_BACKOFF_MIN.length - 1)
  return new Date(Date.now() + RETRY_BACKOFF_MIN[idx] * 60_000).toISOString()
}

function linesToJson(lines: SpecLine[]) {
  return lines.map((l, i) => ({
    line_no: i + 1,
    account_code: l.account_code,
    description: l.description ?? '',
    debit: Math.round((l.debit || 0) * 100) / 100,
    credit: Math.round((l.credit || 0) * 100) / 100,
    currency: l.currency ?? 'CNY',
    exchange_rate: l.exchange_rate ?? 1,
    original_amount: l.original_amount ?? null,
    customer_id: l.customer_id ?? null,
    supplier_name: l.supplier_name ?? null,
    order_id: l.order_id ?? null,
  }))
}

// ── 入队（业务侧调用，仅记录意图，永不失败业务） ──────────
export async function enqueueGlPosting(db: DB, p: EnqueueParams): Promise<string | null> {
  const targetMap: Record<BusinessEvent, string> = {
    order_approved: 'revenue_recognition',
    settlement_confirmed: 'cost_recognition',
    receipt_saved: 'ar_receipt',
    payment_registered: 'ap_payment',
  }
  const { data, error } = await db.from('gl_posting_queue').insert({
    source_type: p.sourceType,
    source_id: p.sourceId,
    business_event: p.businessEvent,
    target_journal_type: targetMap[p.businessEvent],
    status: 'pending',
    requires_review: true,
    created_by: p.createdBy ?? null,
  }).select('id').single()
  if (error) {
    console.error('[gl-queue] enqueue failed:', error.message)
    return null
  }
  return (data as { id: string }).id
}

// ── 取数 + 构造凭证（按事件分流） ──────────────────────────
async function buildSpecForItem(db: DB, item: QueueItem): Promise<JournalSpec | null> {
  switch (item.business_event as BusinessEvent) {
    case 'order_approved': {
      const { data: o } = await db.from('budget_orders')
        .select('id, order_no, customer_id, currency, exchange_rate, total_revenue, order_date, customers(company)')
        .eq('id', item.source_id).single()
      if (!o) throw new GlPostingError('MISSING_SOURCE_DOC', '订单不存在')
      const cust = o.customers as unknown as { company?: string } | null
      return buildRevenueRecognition({
        id: o.id as string, order_no: o.order_no as string,
        customer_id: o.customer_id as string | null, customer_company: cust?.company ?? null,
        currency: (o.currency as string) || 'CNY', exchange_rate: o.exchange_rate as number | null,
        total_revenue: Number(o.total_revenue) || 0, order_date: o.order_date as string,
      })
    }
    case 'settlement_confirmed': {
      const { data: o } = await db.from('budget_orders')
        .select('id, order_no, order_date, currency, exchange_rate, items, target_purchase_price, estimated_commission, estimated_freight, estimated_customs_fee, other_costs')
        .eq('id', item.source_id).single()
      if (!o) throw new GlPostingError('MISSING_SOURCE_DOC', '订单不存在')
      // G1：成本结转优先用「实际费用归集」(cost_items)，与订单核算单/毛利表同口径；
      // 无归集时回退预算成本分解(_cost_breakdown)。cost_items 已按各自币种折 CNY，
      // 故以 currency=CNY/rate=1 传入，避免 buildCostRecognition 再乘一次订单汇率。
      const { data: ci } = await db.from('cost_items')
        .select('cost_type, amount, currency, exchange_rate')
        .eq('budget_order_id', item.source_id).is('deleted_at', null)
      if (ci && ci.length > 0) {
        const cnyOf = (r: Record<string, unknown>) => (Number(r.amount) || 0) * (((r.currency as string) || 'CNY') === 'CNY' ? 1 : (Number(r.exchange_rate) || 1))
        const b = { fabric: 0, accessory: 0, processing: 0, forwarder: 0, container: 0, logistics: 0 }
        for (const r of ci as Record<string, unknown>[]) {
          if (r.cost_type === 'tax_point') continue   // 票点不结转主营业务成本(留作退税核算)
          const v = cnyOf(r)
          switch (r.cost_type) {
            case 'fabric': case 'procurement': b.fabric += v; break
            case 'accessory': b.accessory += v; break
            case 'processing': case 'commission': b.processing += v; break
            case 'freight': b.forwarder += v; break
            case 'container': case 'customs': b.container += v; break
            default: b.logistics += v; break   // logistics / other / 未知
          }
        }
        return buildCostRecognition({
          id: o.id as string, order_no: o.order_no as string, order_date: o.order_date as string,
          currency: 'CNY', exchange_rate: 1,
          fabric: b.fabric, accessory: b.accessory, processing: b.processing,
          forwarder: b.forwarder, container: b.container, logistics: b.logistics, extras: [],
        })
      }
      const cb = (o.items as unknown as Record<string, unknown>[])?.[0]?._cost_breakdown as Record<string, unknown> | undefined
      const num = (k: string, fallback: number) => Number(cb?.[k]) || fallback
      const extras = (cb?.extras as { name: string; amount: number }[]) || []
      // _cost_breakdown 与 target_purchase_price 等预算列全站约定为 CNY——
      // 此前传订单币种/汇率导致 USD 单回退路径成本被再乘一次汇率(虚增约6.9倍,审计 P1)
      return buildCostRecognition({
        id: o.id as string, order_no: o.order_no as string, order_date: o.order_date as string,
        currency: 'CNY', exchange_rate: 1,
        fabric: num('fabric', Number(o.target_purchase_price) || 0),
        accessory: num('accessory', 0),
        processing: num('processing', Number(o.estimated_commission) || 0),
        forwarder: num('forwarder', Number(o.estimated_freight) || 0),
        container: num('container', Number(o.estimated_customs_fee) || 0),
        logistics: num('logistics', Number(o.other_costs) || 0),
        extras,
      })
    }
    case 'receipt_saved': {
      const { data: o } = await db.from('budget_orders')
        .select('id, order_no, customer_id, currency, exchange_rate, total_revenue, order_date, ar_received_amount, ar_received_bank, customers(company)')
        .eq('id', item.source_id).single()
      if (!o) throw new GlPostingError('MISSING_SOURCE_DOC', '订单不存在')
      const cust = o.customers as unknown as { company?: string } | null
      const currency = (o.currency as string) || 'CNY'
      // 已收 CNY 权威口径 = 回款分配合计(amount_cny, 按每笔实际结汇汇率)——
      // 此前用 ar_received_amount×订单预算汇率：projection 改为原币合计后，预算汇率
      // ≠实际结汇时 GL 现金分录与银行实收失真(审计 P1，口径回归)。
      const { data: allocRows } = await db.from('receivable_payment_allocations')
        .select('amount_cny, voided_at, receivable_payments!inner(voided_at)')
        .eq('budget_order_id', item.source_id).is('voided_at', null)
        .is('receivable_payments.voided_at', null)
      let receivedCny: number
      if (allocRows && allocRows.length > 0) {
        receivedCny = Math.round(allocRows.reduce((s, a) => s + (Number(a.amount_cny) || 0), 0) * 100) / 100
      } else {
        // 无流水的历史订单回退：原币×订单汇率(与旧口径一致)
        const rate = currency === 'CNY' ? 1 : Number(o.exchange_rate)
        if (currency !== 'CNY' && (!Number.isFinite(rate) || rate <= 0)) {
          throw new GlPostingError('MISSING_RATE', `订单 ${o.order_no} 缺少有效汇率`)
        }
        receivedCny = Math.round((Number(o.ar_received_amount) || 0) * rate * 100) / 100
      }
      // 已入账（draft+posted）的收款 CNY 净额：正向凭证为正、红字冲销为负
      const { data: prior } = await db.from('journal_entries')
        .select('total_debit, description')
        .eq('source_type', 'receipt').eq('source_id', item.source_id)
        .eq('business_event', 'receipt_saved').in('status', ['draft', 'posted'])
      const already = (prior || []).reduce((s, r) => {
        const td = Number((r as { total_debit: number }).total_debit) || 0
        const isRev = String((r as { description?: string }).description || '').startsWith('收款冲销')
        return s + (isRev ? -td : td)
      }, 0)
      const delta = Math.round((receivedCny - already) * 100) / 100
      return buildArReceipt({
        order: {
          id: o.id as string, order_no: o.order_no as string,
          customer_id: o.customer_id as string | null, customer_company: cust?.company ?? null,
          currency, exchange_rate: o.exchange_rate as number | null,
          total_revenue: Number(o.total_revenue) || 0, order_date: o.order_date as string,
        },
        amountCnyDelta: delta,
        bankName: (o.ar_received_bank as string | null) ?? null,
        bankCode: bankAccountForCurrency(currency),
      })
    }
    case 'payment_registered': {
      const { data: pay } = await db.from('supplier_payments')
        .select('id, supplier_name, amount, currency, paid_at')
        .eq('id', item.source_id).is('deleted_at', null).single()
      if (!pay) throw new GlPostingError('MISSING_SOURCE_DOC', '付款记录不存在')
      return buildApPayment({
        id: pay.id as string, supplier_name: (pay.supplier_name as string) || '未知供应商',
        amount: Number(pay.amount) || 0, currency: (pay.currency as string) || 'CNY',
        exchange_rate: null, paid_at: pay.paid_at as string | null,
      })
    }
    default:
      throw new GlPostingError('MISSING_SOURCE_DOC', `未知业务事件 ${item.business_event}`)
  }
}

interface QueueItem {
  id: string
  source_type: string
  source_id: string
  business_event: string
  target_journal_type: string
  status: string
  attempts: number
  created_by: string | null
}

// ── 处理单个队列项 ────────────────────────────────────────
export async function processQueueItem(db: DB, queueId: string, actorId?: string | null): Promise<{
  status: string; journalId?: string; code?: GlErrorCode; error?: string
}> {
  const { data: itemRow } = await db.from('gl_posting_queue').select('*').eq('id', queueId).single()
  if (!itemRow) return { status: 'failed', error: '队列项不存在' }
  const item = itemRow as unknown as QueueItem

  if (item.status === 'draft_created' || item.status === 'posted' || item.status === 'skipped') {
    return { status: item.status }
  }

  await db.from('gl_posting_queue').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', queueId)

  try {
    // freeze 拦截（订单级冻结时不入账）
    const freezeTargetId = item.source_id
    const fz = await isEntityFrozen(item.source_type === 'supplier_payment' ? 'supplier_payment' : 'budget_order', freezeTargetId)
    if (fz?.frozen) throw new GlPostingError('FREEZE_BLOCKED', '关联实体已冻结，暂不过账')

    const spec = await buildSpecForItem(db, item)
    if (!spec) {
      await db.from('gl_posting_queue').update({ status: 'skipped', last_error: '无需入账（金额为0或差额≤0）', updated_at: new Date().toISOString() }).eq('id', queueId)
      return { status: 'skipped' }
    }

    if (!isBalanced(spec)) throw new GlPostingError('UNBALANCED', '构造的凭证借贷不平衡')

    // 去重：一次性事件（收入/成本/付款）若已有 draft/posted 凭证 → 跳过（回款用差额模型不去重）
    if (spec.targetJournalType !== 'ar_receipt') {
      const { data: dup } = await db.from('journal_entries').select('id')
        .eq('source_type', spec.sourceType).eq('source_id', spec.sourceId)
        .eq('business_event', spec.businessEvent).in('status', ['draft', 'posted']).limit(1)
      if (dup && dup.length > 0) {
        await db.from('gl_posting_queue').update({ status: 'skipped', last_error: '同源凭证已存在，去重跳过', journal_id: (dup[0] as { id: string }).id, updated_at: new Date().toISOString() }).eq('id', queueId)
        return { status: 'skipped', journalId: (dup[0] as { id: string }).id }
      }
    }

    const cfg = getGlConfig()
    const needReview = requiresReview(spec.amountCny, cfg)

    // 生成 DRAFT 凭证（绝不直接 posted）
    const { data: draftRes, error: draftErr } = await db.rpc('create_journal_draft', {
      p_period_code: spec.periodCode,
      p_date: spec.date,
      p_description: spec.description,
      p_source_type: spec.sourceType,
      p_source_id: spec.sourceId,
      p_total_debit: Math.round(spec.lines.reduce((s, l) => s + l.debit, 0) * 100) / 100,
      p_total_credit: Math.round(spec.lines.reduce((s, l) => s + l.credit, 0) * 100) / 100,
      p_created_by: item.created_by,
      p_lines: linesToJson(spec.lines),
      p_business_event: spec.businessEvent,
      p_target_journal_type: spec.targetJournalType,
      p_posting_queue_id: queueId,
      p_related_order_id: spec.provenance.relatedOrderId ?? null,
      p_related_customer_id: spec.provenance.relatedCustomerId ?? null,
      p_related_supplier_name: spec.provenance.relatedSupplierName ?? null,
      p_source_document_id: spec.provenance.sourceDocumentId ?? null,
      p_exchange_rate_source: spec.provenance.exchangeRateSource ?? null,
      p_explanation: spec.provenance.explanation ?? null,
      p_requires_review: needReview,
    })
    if (draftErr) throw draftErr
    const journalId = (draftRes as { journal_id: string }).journal_id

    // 仅当低风险且开关开启 → 自动过账
    if (shouldAutoPost(spec.amountCny, cfg)) {
      const { error: postErr } = await db.rpc('post_journal', { p_journal_id: journalId, p_posted_by: item.created_by })
      if (postErr) {
        // draft 已生成；过账失败 → 队列标记 failed 但保留 draft，可人工 review/重试
        await recordGlFailure(db, item, classifyGlError(postErr), `自动过账失败：${postErr.message}`, journalId)
        await db.from('gl_posting_queue').update({
          status: 'failed', journal_id: journalId, requires_review: true,
          attempts: item.attempts + 1, last_error: postErr.message, last_error_code: classifyGlError(postErr),
          next_retry_at: backoffIso(item.attempts), updated_at: new Date().toISOString(),
        }).eq('id', queueId)
        return { status: 'failed', journalId, code: classifyGlError(postErr), error: postErr.message }
      }
      await db.from('gl_posting_queue').update({
        status: 'posted', journal_id: journalId, requires_review: false, approved_by: item.created_by,
        amount_cny: spec.amountCny, updated_at: new Date().toISOString(),
      }).eq('id', queueId)
      await recordTimeline(db, item, 'gl_auto_posted', `自动过账 ¥${spec.amountCny}`, { journalId, amountCny: spec.amountCny }, actorId)
      return { status: 'posted', journalId }
    }

    // 默认：draft + requires_review，等人工复核
    await db.from('gl_posting_queue').update({
      status: 'draft_created', journal_id: journalId, requires_review: needReview,
      amount_cny: spec.amountCny, updated_at: new Date().toISOString(),
    }).eq('id', queueId)
    await recordTimeline(db, item, 'gl_draft_created', `生成草稿凭证 ¥${spec.amountCny}，待复核`, { journalId, amountCny: spec.amountCny }, actorId)
    return { status: 'draft_created', journalId }

  } catch (err) {
    const code = classifyGlError(err)
    const msg = err instanceof Error ? err.message
      : (err && typeof err === 'object' && 'message' in err) ? String((err as { message: unknown }).message ?? '')
      : String(err)
    await recordGlFailure(db, item, code, msg)
    await db.from('gl_posting_queue').update({
      status: 'failed', attempts: item.attempts + 1, last_error: msg, last_error_code: code,
      next_retry_at: backoffIso(item.attempts), requires_review: true, updated_at: new Date().toISOString(),
    }).eq('id', queueId)
    return { status: 'failed', code, error: msg }
  }
}

// ── 异常中心：写 audit_findings + entity_timeline ─────────
const SEVERITY_BY_CODE: Partial<Record<GlErrorCode, 'info' | 'warning' | 'critical'>> = {
  UNBALANCED: 'critical', ACCOUNT_MISSING: 'critical', MISSING_PROVENANCE: 'critical',
  MISSING_RATE: 'warning', PERIOD_CLOSED: 'warning', FREEZE_BLOCKED: 'warning',
  DUPLICATE_SOURCE: 'info', MISSING_SOURCE_DOC: 'warning',
}

async function recordGlFailure(db: DB, item: QueueItem, code: GlErrorCode, message: string, journalId?: string) {
  const severity = SEVERITY_BY_CODE[code] || 'warning'
  const evidence = {
    error_code: code, error: message, source_type: item.source_type, source_id: item.source_id,
    business_event: item.business_event, target_journal_type: item.target_journal_type,
    queue_id: item.id, journal_id: journalId ?? null, attempts: item.attempts + 1,
  }
  // 去重：同一队列项已有 open 的 finding → 更新，否则插入
  const { data: existing } = await db.from('audit_findings').select('id')
    .eq('finding_type', 'gl_posting_failure').eq('entity_id', item.id).eq('status', 'open').limit(1)
  if (existing && existing.length > 0) {
    await db.from('audit_findings').update({
      severity, description: `[${code}] ${message}`, evidence,
    }).eq('id', (existing[0] as { id: string }).id)
  } else {
    await db.from('audit_findings').insert({
      finding_type: 'gl_posting_failure', severity, entity_type: 'gl_posting_queue', entity_id: item.id,
      title: `GL过账失败：${item.business_event} (${code})`,
      description: `[${code}] ${message}`, evidence, status: 'open',
    })
  }
  await recordTimeline(db, item, 'gl_posting_failed', `GL过账失败 [${code}] ${message}`, evidence)
}

async function recordTimeline(db: DB, item: QueueItem, eventType: string, title: string, detail: Record<string, unknown>, actorId?: string | null) {
  try {
    await db.from('entity_timeline').insert({
      entity_type: 'gl_posting_queue', entity_id: item.id,
      event_type: eventType, event_title: title, event_detail: detail,
      source_type: 'system', actor_id: actorId ?? null,
    })
  } catch (e) {
    console.error('[gl-queue] timeline insert failed:', e)
  }
}

// ── 公共入口：入队 + 立即处理（业务页面非阻塞调用） ──────
export async function enqueueAndProcess(p: EnqueueParams): Promise<{ queueId: string | null; result?: Awaited<ReturnType<typeof processQueueItem>> }> {
  const db = await createClient()
  const queueId = await enqueueGlPosting(db, p)
  if (!queueId) return { queueId: null }
  const result = await processQueueItem(db, queueId, p.createdBy)
  return { queueId, result }
}

// ── 手动重试失败项 ────────────────────────────────────────
export async function retryQueueItem(queueId: string, actorId?: string | null): Promise<Awaited<ReturnType<typeof processQueueItem>>> {
  const db = await createClient()
  // 复位为 pending，清理上次错误关联的 open finding（标记 resolved）
  await db.from('gl_posting_queue').update({ status: 'pending', next_retry_at: null, updated_at: new Date().toISOString() }).eq('id', queueId)
  const r = await processQueueItem(db, queueId, actorId)
  if (r.status === 'draft_created' || r.status === 'posted' || r.status === 'skipped') {
    await db.from('audit_findings').update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: actorId ?? null, resolution_note: `重试成功：${r.status}` })
      .eq('finding_type', 'gl_posting_failure').eq('entity_id', queueId).eq('status', 'open')
  }
  return r
}

// ── 处理待办/到期重试（worker/cron 用） ───────────────────
export async function processPendingQueue(limit = 50): Promise<{ processed: number }> {
  const db = await createClient()
  const nowIso = new Date().toISOString()
  const { data: pend } = await db.from('gl_posting_queue').select('id, status, next_retry_at')
    .or(`status.eq.pending,and(status.eq.failed,next_retry_at.lte.${nowIso})`)
    .order('created_at', { ascending: true }).limit(limit)
  let processed = 0
  for (const row of (pend || [])) {
    await processQueueItem(db, (row as { id: string }).id)
    processed++
  }
  return { processed }
}
