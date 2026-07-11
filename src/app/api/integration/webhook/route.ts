// ============================================================
// POST /api/integration/webhook
// 接收来自订单节拍器的 Webhook 事件
// 安全：API Key + HMAC签名 + 时间戳防重放 + 幂等性
// ============================================================

import { NextResponse } from 'next/server'
import {
  validateRequest,
  checkRateLimit,
  isRequestProcessed,
  markRequestProcessed,
} from '@/lib/integration/security'
import type { WebhookPayload, SyncedOrder, PriceApprovalRequest } from '@/lib/integration/types'
import { createServiceClient } from '@/lib/supabase/service'
import { preflightOrderVoid } from '@/lib/financial/order-void'

export async function POST(request: Request) {
  // 1. 速率限制
  const clientIp = request.headers.get('x-forwarded-for') || 'unknown'
  if (!checkRateLimit(clientIp, 120, 60_000)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

  // 2. 安全验证（API Key + 签名 + 时间戳）
  const validation = await validateRequest(request)
  if (!validation.valid) {
    console.error(`[Webhook] Security validation failed: ${validation.error}`)
    // 记录鉴权失败（用于联调诊断 — API Key 不一致 / 签名错 / 时间戳过期）
    try {
      const supabase = createServiceClient()
      const apiKey = request.headers.get('x-api-key') || ''
      const apiKeyMasked = apiKey.length > 8
        ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)} (len=${apiKey.length})`
        : `(len=${apiKey.length})`
      await supabase.from('integration_logs').insert({
        event_type: 'auth.failed',
        direction: 'inbound',
        request_id: `auth-fail-${Date.now()}`,
        source: clientIp,
        status: 'failed',
        payload_summary: `apiKey=${apiKeyMasked} hasSignature=${!!request.headers.get('x-webhook-signature')}`,
        error_message: validation.error || 'unknown',
      })
    } catch (e) {
      console.error('[Webhook] Failed to log auth failure:', e)
    }
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  // 3. 解析事件
  let payload: WebhookPayload
  try {
    payload = JSON.parse(validation.body!)
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // 4. 幂等性检查：DB 级(inbox request_id 唯一约束,跨实例可靠) + 内存 Map(热路径)
  if (isRequestProcessed(payload.request_id)) {
    return NextResponse.json({ status: 'already_processed', request_id: payload.request_id })
  }
  const inboxDb = createServiceClient()
  let inboxLanded = false
  try {
    const { error: inboxErr } = await inboxDb.from('fin_inbox_events').insert({
      request_id: payload.request_id,
      event: payload.event,
      source: payload.source || 'order-metronome',
      payload: payload as unknown as Record<string, unknown>,
      process_status: 'processing',
      attempt_count: 1,
    })
    if (inboxErr) {
      if (/duplicate|unique/i.test(inboxErr.message)) {
        // 已存在同 request_id：done/ignored → 幂等返回；failed 或卡死 processing(>10分钟,
        // 函数崩溃未回写) → 原子抢占重试。此前一律 already_processed，失败事件永久黑洞(审计 P0)。
        const { data: prev } = await inboxDb.from('fin_inbox_events')
          .select('process_status, attempt_count, received_at')
          .eq('request_id', payload.request_id).maybeSingle()
        const stale = prev?.process_status === 'processing'
          && prev?.received_at && (Date.now() - new Date(prev.received_at as string).getTime() > 10 * 60_000)
        if (prev && (prev.process_status === 'failed' || stale)) {
          // 乐观锁抢占：以 attempt_count 作版本号。旧实现 CAS 谓词是 .in(status,['failed','processing'])，
          // 而抢占又把状态写成 'processing'——目标态在匹配集内，两个实例并发重试会都命中、都认领成功、
          // 各处理一遍 → 重复建单(审计 P0-2)。改为 WHERE attempt_count = prev：只有版本匹配者胜出，
          // 胜者把它 +1，另一实例此时读到的版本已过期，匹配 0 行,安全退出。
          const prevAttempt = Number(prev.attempt_count) || 0
          const { data: claimed } = await inboxDb.from('fin_inbox_events')
            // 审计P2:抢占时刷新 received_at,让 10 分钟 stale 冷却从「本次认领」起算,
            // 否则一直从最初收报起算 → 连续失败的事件每次重投都立刻可再抢、无冷却、反复重跑。
            .update({ process_status: 'processing', attempt_count: prevAttempt + 1, last_error: null, received_at: new Date().toISOString() })
            .eq('request_id', payload.request_id)
            .eq('attempt_count', prevAttempt)                     // ← 原子 CAS：版本号
            .in('process_status', ['failed', 'processing'])       // 仅 failed / (stale)processing 可抢
            .select('request_id')
          if (claimed && claimed.length > 0) {
            inboxLanded = true   // 抢占成功 → 继续走处理(重试)
          } else {
            return NextResponse.json({ status: 'already_processed', request_id: payload.request_id })
          }
        } else {
          return NextResponse.json({ status: 'already_processed', request_id: payload.request_id })
        }
      } else {
        // 落账失败不再降级为内存幂等(Vercel 多实例下形同无幂等) → 503 让上游可感知重试
        console.error('[Webhook] inbox 落账失败:', inboxErr.message)
        return NextResponse.json({ error: 'Inbox unavailable, retry later' }, { status: 503 })
      }
    } else {
      inboxLanded = true
    }
  } catch (e) {
    console.error('[Webhook] inbox 落账异常:', e)
    return NextResponse.json({ error: 'Inbox unavailable, retry later' }, { status: 503 })
  }

  // 5. 处理事件
  try {
    const result = await handleWebhookEvent(payload)
    markRequestProcessed(payload.request_id)

    // 6. 记录集成日志 + inbox 状态回写
    await logIntegrationEvent(payload, 'inbound', 'success')
    if (inboxLanded) {
      // test.ping=ignored；已消费事件=done；暂未消费(milestone/resync/supplier 等)=pending 留待后续入账
      const status = payload.event === 'test.ping'
        ? 'ignored'
        : ((result as { action?: string })?.action === 'ignored' ? 'pending' : 'done')
      await inboxDb.from('fin_inbox_events')
        .update({ process_status: status, processed_at: new Date().toISOString() })
        .eq('request_id', payload.request_id)
    }

    return NextResponse.json({
      status: 'ok',
      request_id: payload.request_id,
      result,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Webhook] Processing error: ${errorMsg}`)
    await logIntegrationEvent(payload, 'inbound', 'failed', errorMsg)
    if (inboxLanded) {
      await inboxDb.from('fin_inbox_events')
        .update({ process_status: 'failed', last_error: errorMsg.slice(0, 500) })  // attempt_count 由落账/抢占时维护,不在此重置
        .eq('request_id', payload.request_id)
    }

    return NextResponse.json(
      { error: 'Processing failed', detail: errorMsg },
      { status: 500 }
    )
  }
}

// --- 事件处理路由 ---
async function handleWebhookEvent(payload: WebhookPayload) {
  switch (payload.event) {
    case 'order.created':
    case 'order.updated':
    case 'order.activated':
    case 'order.resync':   // 订单系统"重新同步"按钮：payload 与 order.updated 同构,复用同步(此前落 ignored=按钮无效,审计 P0)
      return handleOrderSync(payload.data as unknown as SyncedOrder, payload.event)

    case 'order.completed':
      return handleOrderStatusChange(payload.data as unknown as SyncedOrder, payload.event)

    // 审计 C1:删单/取消此前只更新 lifecycle_status(order.deleted 更是落 ignored)→
    // 财务侧预算草稿/应付永久残留成幽灵单据。改为保守冲销(见 handleOrderReversal)。
    case 'order.cancelled':
    case 'order.deleted':
      return handleOrderReversal(payload.data as unknown as SyncedOrder, payload.event)

    case 'price_approval.requested':
      return handlePriceApprovalRequest(payload.data as unknown as PriceApprovalRequest)

    // (delay.requested 已移除 2026-07-09:节拍器改期只走内部审批、从不推财务,幽灵能力删除)

    // 取消订单/里程碑 财务审批(接通:节拍器发起 → 财务审批队列 → 批/驳回传 approval_type:'cancel'/'milestone')
    case 'cancel.requested':
      return handleGenericApprovalRequest(payload.data as Record<string, unknown>, 'cancel')
    case 'milestone.requested':
      return handleGenericApprovalRequest(payload.data as Record<string, unknown>, 'milestone')
    // 出货 财务审批(2026-07-11:节拍器业务申请出货 → 财务队列 → 批/驳回传 approval_type:'shipment')
    case 'shipment_approval.requested':
      return handleGenericApprovalRequest(payload.data as Record<string, unknown>, 'shipment')
    // 业务撤回出货申请 → 队列里未决的那条置 expired(CHECK 无 'cancelled';已决的不动)
    case 'shipment_approval.cancelled':
      return handleShipmentApprovalCancelled(payload.data as Record<string, unknown>)

    case 'file.uploaded':
      return handleFileUpload(payload.data as Record<string, unknown>)

    case 'purchase_order.placed':
      return handlePurchaseOrderPlaced(payload.data as Record<string, unknown>, payload.request_id)

    // 采购单审批(≥¥5000):节拍器下单前发本事件卡住采购,财务侧本单进「待审批」。
    // 复用采购单落库逻辑,仅把 fin_status 置 pending_approval + requires_approval。
    case 'purchase_order.approval_requested':
      return handlePurchaseOrderPlaced(payload.data as Record<string, unknown>, payload.request_id, true)

    // 采购审批撤销(2026-07-09):节拍器删单/取消单时,对其下"待审"采购单发本事件 →
    // 财务把该单移出「采购审批」队列(soft-delete),否则订单没了、审批还挂着。
    case 'purchase_order.approval_cancelled':
      return handlePurchaseOrderApprovalCancelled(payload.data as Record<string, unknown>)

    // 审计 P0-3:此前无 case→落 default ignored→inbox 假 pending 永久堆积(生产库卡了 61 条)。
    // 现消费为供应商主数据 upsert，财务侧供应商档随节拍器同步。
    case 'supplier.upserted':
      return handleSupplierUpsert(payload.data as Record<string, unknown>)

    // 收货回财务(审计修 2026-07-05):节拍器三条收货入口发本事件(po_no/line_id/
    // received_qty_total/inspection_result)。当前先确认接收(原始数据存 fin_inbox_events,
    // 不再当 unknown 堆积);按实收核销应付需建 fin_goods_receipts 表(finance 迁移)后深处理。
    case 'goods_receipt.recorded':
      return handleGoodsReceiptRecorded(payload.data as Record<string, unknown>)

    // 内部报价单冻结 → 财务预算自动到位(结构化 6 桶+逐行明细+收款款号+核算日期/版本)。
    // 只填 draft 预算(不覆盖已审批);来源标 qimo_quotation,带 _quotation_at 供版本追溯。
    case 'quotation.frozen':
      return handleQuotationFrozen(payload.data as Record<string, unknown>)

    // 采购核料预算即时更新(2026-07-08):业务在采购核料按真实物料填/改预算 → 节拍器送【绝对总额】
    // budget_totals{fabric_amount,cmt_amount,accessory_amount}。复用 quotation.frozen 的预算填充
    // (映射成 cost_buckets 绝对桶,不走 unit_costs 的单件×数量,避免逐款件数不一致的漂移)。只填 draft。
    case 'order.budget_updated':
      return handleOrderBudgetUpdated(payload.data as Record<string, unknown>)

    // 出货发票金额 → 应收(2026-07-10):节拍器出运完成推累计 CI 金额。draft 预算 → 以 CI 更新
    // total_revenue(应收);已确认 → 只存快照 + 记 integration_logs 告警,绝不自动改账。
    case 'shipping_invoice.issued':
      return handleShippingInvoiceIssued(payload.data as Record<string, unknown>)

    // 采购对账付款申请 → 财务应付入账(2026-07-11 P2):节拍器采购对账确认后提付款申请,
    // source_ref=节拍器付款申请id(幂等键)。detail.lines 存采购订单↔供应商对账明细供付款审批核对。
    case 'payable.created':
      return handlePayableCreated(payload.data as Record<string, unknown>, payload.request_id)

    default:
      return { action: 'ignored', reason: `Unknown event type: ${payload.event}` }
  }
}

// --- 采购单下单入账（V1.0 头；V1.1 lines 行数据预留） ---
// 老板 2026-07-11:所有采购单一律须财务审批(取消 ¥5000 门槛)。placed / approval_requested
//   两个事件都把本单落成「待审批」pending_approval;_requireApproval 形参仅留历史签名兼容,不再决定门槛。
async function handlePurchaseOrderPlaced(data: Record<string, unknown>, requestId: string, _requireApproval = false) {
  const supabase = createServiceClient()
  const poKey = String(data.purchase_order_id || data.po_no || '')
  if (!poKey) throw new Error('purchase_order 缺少 purchase_order_id/po_no')

  const totalAmount = data.total_amount != null ? Number(data.total_amount) : null
  // 审计 P1 幂等:仅「新单 / 仍待处理(pending)」才置待审批;已进入审批或已入账/忽略的
  //   (pending_approval/approved/rejected/registered/ignored)inbox 重投/重发一律不改状态,
  //   否则已批已下单的单凭空回到待审、留痕与状态自相矛盾。
  const { data: existing } = await supabase.from('fin_purchase_orders')
    .select('fin_status').eq('purchase_order_id', poKey).maybeSingle()
  const cur = (existing as { fin_status?: string } | null)?.fin_status || null
  const gated = !cur || cur === 'pending'   // 新单或旧 pending → 送审批
  const headExtra: Record<string, unknown> = gated
    ? { fin_status: 'pending_approval', requires_approval: true }
    : {}

  const { data: poRow, error: poErr } = await supabase.from('fin_purchase_orders').upsert({
    purchase_order_id: poKey,
    po_no: String(data.po_no || poKey),
    supplier_id: (data.supplier_id as string) ?? null,
    supplier_name: (data.supplier_name as string) ?? null,
    total_amount: totalAmount,
    currency: (data.currency as string) || 'CNY',
    payment_terms: (data.payment_terms as string) ?? null,
    delivery_date: (data.delivery_date as string) ?? null,
    status: (data.status as string) ?? null,
    placed_at: (data.placed_at as string) ?? null,
    order_refs: (data.order_refs as unknown[]) ?? [],
    source_request_id: requestId,
    updated_at: new Date().toISOString(),
    ...headExtra,
  }, { onConflict: 'purchase_order_id' }).select('id').single()
  if (poErr) throw new Error(`fin_purchase_orders 写入失败: ${poErr.message}`)

  // V1.1：行数据（line_id 为对账锚点，upsert 幂等）
  const lines = Array.isArray(data.lines) ? (data.lines as Record<string, unknown>[]) : []
  let lineCount = 0
  if (lines.length > 0 && poRow) {
    const rows = lines.filter(l => l && (l.line_id || l.id)).map(l => ({
      fin_po_id: poRow.id as string,
      line_id: String(l.line_id || l.id),
      order_id: (l.order_id as string) ?? null,
      order_no: (l.order_no as string) ?? null,
      internal_order_no: (l.internal_order_no as string) ?? null,
      style_no: (l.style_no as string) ?? null,
      material_name: (l.material_name as string) ?? null,
      material_code: (l.material_code as string) ?? null,
      specification: (l.specification as string) ?? null,
      category: (l.category as string) ?? null,
      // 颜色/尺码(2026-07-11):同料多色行财务要按色核数量,此前节拍器发了这里丢弃
      color: (l.color as string) ?? null,
      size: (l.size as string) ?? null,
      // 行级供应商(预算原辅料按供应商分组的源;不同料下给不同供应商)
      supplier_id: (l.supplier_id as string) ?? null,
      supplier_name: (l.supplier_name as string) ?? null,
      ordered_qty: l.ordered_qty != null ? Number(l.ordered_qty) : null,
      ordered_unit: (l.ordered_unit as string) ?? null,
      unit_price: l.unit_price != null ? Number(l.unit_price) : null,
      amount: l.amount != null ? Number(l.amount) : null,
    }))
    if (rows.length > 0) {
      const { error: lineErr } = await supabase.from('fin_po_lines').upsert(rows, { onConflict: 'line_id' })
      if (lineErr) throw new Error(`fin_po_lines 写入失败: ${lineErr.message}`)
      lineCount = rows.length
    }
  }

  // 契约扩展(2026-07-11):PO 推送可内联附件(PO单据/内部报价单),落 uploaded_documents 并关联本采购单。
  // attachments: [{ id?, file_name, file_type?, file_size?, file_url, doc_hint?('po'|'internal_quote'), order_id? }]
  // 附件写入失败不阻断 PO 本体(附件可由 file.uploaded 事件补发),但计入返回供节拍器侧观察。
  const atts = Array.isArray(data.attachments) ? (data.attachments as Record<string, unknown>[]) : []
  let attCount = 0
  let attError: string | null = null
  for (const a of atts) {
    if (!a || !a.file_url) continue
    const docHint = (a.doc_hint as string) || null
    const row = {
      file_name: (a.file_name as string) || 'unnamed',
      file_type: (a.file_type as string) || 'pdf',
      file_size: a.file_size != null ? Number(a.file_size) : null,
      file_url: String(a.file_url),
      status: 'pending',
      extracted_fields: {},
      related_purchase_order_id: poKey,
      related_qimo_order_id: (a.order_id as string) || null,
      doc_hint: docHint,
    }
    // 有节拍器文件 id 用 id 幂等;没有则按(采购单, file_url)去重
    if (a.id) {
      const { error: e } = await supabase.from('uploaded_documents').upsert({ id: String(a.id), ...row }, { onConflict: 'id' })
      if (e) { attError = e.message; continue }
      attCount++
    } else {
      const { data: dup } = await supabase.from('uploaded_documents')
        .select('id').eq('related_purchase_order_id', poKey).eq('file_url', row.file_url).limit(1)
      if (dup && dup.length > 0) { attCount++; continue }
      const { error: e } = await supabase.from('uploaded_documents').insert(row)
      if (e) { attError = e.message; continue }
      attCount++
    }
  }

  return {
    action: gated ? 'po_pending_approval' : 'po_updated',
    po_no: String(data.po_no || poKey), lines: lineCount,
    ...(atts.length > 0 ? { attachments: attCount, attachment_error: attError } : {}),
  }
}

// --- 采购审批撤销(订单删/取消时,节拍器逐张发)---
// 只撤"未决"(pending/pending_approval)的:soft-delete 即移出审批队列(getPendingPurchaseApprovals 过滤 deleted_at)。
// 已批/已付(approved/paid)绝不自动动 → 仅警告需人工红冲。幂等:已 deleted 的当已撤。
async function handlePurchaseOrderApprovalCancelled(data: Record<string, unknown>) {
  const supabase = createServiceClient()
  const poId = data.purchase_order_id ? String(data.purchase_order_id) : ''
  const poNo = data.po_no ? String(data.po_no) : ''
  if (!poId && !poNo) return { action: 'ignored', reason: 'approval_cancelled 缺 purchase_order_id/po_no' }

  let q = supabase.from('fin_purchase_orders').select('id, po_no, fin_status, deleted_at')
  q = poId ? q.eq('purchase_order_id', poId) : q.eq('po_no', poNo)
  const { data: rows } = await q
  const list = (rows as { id: string; po_no?: string; fin_status?: string; deleted_at?: string | null }[] | null) || []
  if (!list.length) return { action: 'ok', reason: `未找到采购单(po=${poNo || poId}),可能尚未同步或已清除` }

  const now = new Date().toISOString()
  const reason = String(data.reason || 'order_removed')
  const undecided = list.filter(p => !p.deleted_at && (p.fin_status === 'pending' || p.fin_status === 'pending_approval'))
  const decided = list.filter(p => !p.deleted_at && (p.fin_status === 'approved' || p.fin_status === 'paid'))
  if (undecided.length) {
    const { error } = await supabase.from('fin_purchase_orders')
      .update({ deleted_at: now, approval_note: `节拍器撤销采购审批(${reason})`, updated_at: now })
      .in('id', undecided.map(p => p.id))
    if (error) throw new Error(`采购审批撤销失败: ${error.message}`)
  }
  if (decided.length) {
    return { action: 'done', reason: `撤销 ${undecided.length} 张待审;另有 ${decided.length} 张已批/已付需人工红冲(未自动动)` }
  }
  return { action: 'done', reason: `撤销 ${undecided.length} 张待审采购审批(po=${poNo || poId})` }
}

// --- 供应商主数据 upsert（审计 P0-3）---
// 节拍器 supplier.upserted → 财务 suppliers 档。按【精确名】匹配(不用子串,避免串号)：
// 已有则补溯源 notes(不覆盖财务已维护的银行/联系资料)，没有则新建。
// suppliers 非 trigger 保护的核心财务表，可安全 upsert。
/**
 * 收货回财务(审计修 2026-07-05):节拍器收货入口发来实收+验收结论。
 * 尝试把实收写到对账行 fin_po_lines.received_qty(按 line_id);列未建则优雅确认
 * (原始数据已进 fin_inbox_events,不丢),按实收深核销应付待建 fin_goods_receipts 表后做。
 */
async function handleGoodsReceiptRecorded(data: Record<string, unknown>) {
  const lineId = String(data.line_id || '')
  const poNo = String(data.po_no || '')
  const received = data.received_qty_total != null ? Number(data.received_qty_total) : null
  if (!lineId && !poNo) return { action: 'ignored', reason: 'goods_receipt.recorded 缺 line_id/po_no' }
  try {
    if (lineId && received != null) {
      const supabase = createServiceClient()
      // 审计P1:必须 .select 判影响行数;写失败/0行匹配都不能报 done(否则 inbox 置 done 永不重试、
      // 收货静默蒸发)。改返回 ignored → inbox 留 pending 可重投,原始数据也在 fin_inbox_events。
      const { data: hit, error } = await supabase.from('fin_po_lines')
        .update({ received_qty: received, inspection_result: (data.inspection_result as string) ?? null, received_at: new Date().toISOString() })
        .eq('line_id', lineId).select('line_id')
      if (error) return { action: 'ignored', reason: `收货写入失败,待重试(数据存 inbox):${error.message}` }
      if (hit && hit.length > 0) return { action: 'done', reason: `收货核销 line=${lineId} received=${received}` }
      // 审计:line_id 常对不上(采购明细同步用了不同 id)→ po_no + 料名 双锚点兜底匹配
      const matName = (data.material_name as string) || ''
      if (poNo && matName) {
        const { data: pos } = await supabase.from('fin_purchase_orders').select('id').eq('po_no', poNo).is('deleted_at', null)
        const poIds = (pos || []).map(p => (p as { id: string }).id)
        if (poIds.length) {
          const { data: hit2 } = await supabase.from('fin_po_lines')
            .update({ received_qty: received, inspection_result: (data.inspection_result as string) ?? null, received_at: new Date().toISOString() })
            .in('fin_po_id', poIds).eq('material_name', matName).select('line_id')
          if (hit2 && hit2.length > 0) return { action: 'done', reason: `收货核销(po_no+料名兜底) po=${poNo} 料=${matName} received=${received}` }
        }
      }
      return { action: 'ignored', reason: `line_id=${lineId}/po_no=${poNo} 均未匹配到采购对账行(采购明细未同步),待重试/人工核对——收货未核销` }
    }
  } catch (e) {
    return { action: 'ignored', reason: `收货处理异常,待重试(数据存 inbox):${e instanceof Error ? e.message : e}` }
  }
  return { action: 'ignored', reason: `收货缺 line_id/received,未核销 line=${lineId} po=${poNo}` }
}

// --- 内部报价单冻结 → 财务预算自动到位（结构化 6 桶 + 逐行明细 + 收款款号 + 核算日期/版本）---
// 契约：payload.data = { qimo_order_id, order_no, internal_order_no?, quote_id?, quote_version?,
//   quotation_at(核算日期ISO), currency, exchange_rate?,
//   revenue_lines?:[{sku,name,qty,unit_price,amount}],   // 收(款号,原币)
//   cost_buckets?:{fabric,accessory,processing,forwarder,container,logistics},  // 6桶(CNY)
//   cost_lines?:{ fabric:[{name,supplier?,qty,unit,unit_price,amount}], ... } } // 逐行(CNY)
async function handleQuotationFrozen(data: Record<string, unknown>) {
  const supabase = createServiceClient()
  const qimoOrderId = (data.qimo_order_id as string) || ''
  const orderNo = (data.order_no as string) || ''
  const quotationAt = (data.quotation_at as string) || null
  const quoteId = (data.quote_id as string) || null
  if (!qimoOrderId && !orderNo) return { action: 'ignored', reason: 'quotation.frozen 缺 qimo_order_id/order_no' }

  // 1. 定位 budget_order：优先 qimo_order_id(结构化)，退回 synced_orders.order_no → budget_order_id
  let budgetOrderId: string | null = null
  if (qimoOrderId) {
    const { data: bo } = await supabase.from('budget_orders').select('id').eq('qimo_order_id', qimoOrderId).is('deleted_at', null).maybeSingle()
    budgetOrderId = bo?.id ?? null
  }
  if (!budgetOrderId && orderNo) {
    const { data: so } = await supabase.from('synced_orders').select('budget_order_id').eq('order_no', orderNo).not('budget_order_id', 'is', null).maybeSingle()
    budgetOrderId = (so?.budget_order_id as string) ?? null
  }

  // 2. 冻结报价原文 + 核算日期回写 synced_orders（便于追溯，即便预算未建）
  const snapPatch = { quotation_data: data, qimo_quote_id: quoteId, quotation_applied_at: quotationAt }
  if (qimoOrderId) await supabase.from('synced_orders').update(snapPatch).eq('id', qimoOrderId)
  else if (orderNo) await supabase.from('synced_orders').update(snapPatch).eq('order_no', orderNo)

  if (!budgetOrderId) {
    await logFinancialDrop('quotation.frozen', orderNo || qimoOrderId, `报价已收到但订单尚未建预算单,报价成本结构未入预算(order=${orderNo || qimoOrderId}),待人工建预算单后采纳`)
    return { action: 'ok', reason: `报价已存(synced_orders)，但该订单尚未建预算单(order=${orderNo})` }
  }

  // 3. 只填 draft 预算，不覆盖已审批/已锁（报价存 synced_orders 待人工采纳）
  const { data: bo } = await supabase.from('budget_orders').select('status, total_revenue').eq('id', budgetOrderId).maybeSingle()
  if (bo && bo.status !== 'draft') {
    await logFinancialDrop('quotation.frozen', orderNo || qimoOrderId, `预算单非 draft(${bo?.status}),报价成本结构未自动覆盖、未入账,待人工采纳(order=${orderNo || qimoOrderId})`)
    return { action: 'ok', reason: `预算单非 draft(${bo?.status})，不自动覆盖，报价已存待人工采纳` }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100
  const BUCKETS = ['fabric', 'accessory', 'processing', 'forwarder', 'container', 'logistics']

  // 4a. 单件成本模式：内部成本核算单给的是【每件单价】(面料/加工/辅料 + 含税售价)。
  //     财务用共享的订单数量 synced_orders.quantity 换算订单预算(单价×数量)。
  //     面料给净布价+单耗 → 按 kg 口径出带供应商明细;货代/装柜/物流不在核算单里,留财务补录。
  let inLines = (data.cost_lines as Record<string, Array<Record<string, unknown>>>) || {}
  let revLinesSrc = Array.isArray(data.revenue_lines) ? (data.revenue_lines as Array<Record<string, unknown>>) : []
  const uc = data.unit_costs as Record<string, unknown> | undefined
  let qtyUsed: number | null = null
  if (uc) {
    const { data: so } = await supabase.from('synced_orders').select('quantity')
      .eq(qimoOrderId ? 'id' : 'order_no', qimoOrderId || orderNo).maybeSingle()
    const qty = Number(so?.quantity) || 0
    qtyUsed = qty
    const num = (k: string) => Number(uc[k]) || 0
    if (qty > 0) {
      const fLine: Record<string, unknown> = { name: String(uc.fabric_name || '面料'), qty, unit: '件', unit_price: num('fabric_per_piece'), amount: r2(qty * num('fabric_per_piece')) }
      if (uc.fabric_supplier) fLine.supplier = String(uc.fabric_supplier)
      if (num('fabric_consumption_kg') > 0 && num('fabric_net_price_per_kg') > 0) {
        fLine.qty = r2(qty * num('fabric_consumption_kg')); fLine.unit = 'kg'
        fLine.unit_price = num('fabric_net_price_per_kg'); fLine.amount = r2(qty * num('fabric_consumption_kg') * num('fabric_net_price_per_kg'))
      }
      inLines = {
        fabric: [fLine],
        processing: [{ name: '加工费', qty, unit: '件', unit_price: num('processing_per_piece'), amount: r2(qty * num('processing_per_piece')) }],
        accessory: [{ name: '辅料', qty, unit: '件', unit_price: num('accessory_per_piece'), amount: r2(qty * num('accessory_per_piece')) }],
      }
      if (num('selling_price_per_piece') > 0) revLinesSrc = [{ sku: null, name: '货款', qty, unit_price: num('selling_price_per_piece'), amount: r2(qty * num('selling_price_per_piece')) }]
    }
  }

  // 4b. 组装 _cost_breakdown（6 桶 + 逐行明细，桶标量=明细之和维持不变量）
  const inBuckets = (data.cost_buckets as Record<string, unknown>) || {}
  const lines: Record<string, unknown[]> = {}
  const scalar: Record<string, number> = {}
  for (const b of BUCKETS) {
    const arr = Array.isArray(inLines[b]) ? inLines[b] : []
    const mapped = arr.map(l => ({
      name: String(l.name || '(无摘要)'),
      ...(l.supplier ? { supplier: String(l.supplier) } : {}),
      qty: Number(l.qty) || 0, unit: String(l.unit || ''),
      unit_price: r2(Number(l.unit_price) || 0), amount: r2(Number(l.amount) || 0),
    })).filter(l => l.amount || (l.qty && l.unit_price))
    if (mapped.length) { lines[b] = mapped; scalar[b] = r2(mapped.reduce((s, l) => s + l.amount, 0)) }
    else scalar[b] = r2(Number(inBuckets[b]) || 0)
  }
  const currency = (data.currency as string) || 'CNY'
  const rate = data.exchange_rate != null ? Number(data.exchange_rate) : (currency === 'CNY' ? 1 : null)
  const revenueLines = revLinesSrc
  const revItems = revenueLines.map(l => ({
    sku: l.sku ? String(l.sku) : null,
    product_name: [l.sku, l.name].filter(Boolean).join(' ') || '-',
    qty: Number(l.qty) || 0, unit_price: r2(Number(l.unit_price) || 0), amount: r2(Number(l.amount) || 0),
  }))
  const revenueTotal = r2(revItems.reduce((s, l) => s + l.amount, 0))
  const cb = {
    ...scalar, extras: [], lines,
    _currency: 'CNY', _revenue_input: revenueTotal || Number(bo?.total_revenue) || 0,
    _revenue_currency: currency, _rate: rate,
    _source: 'qimo_quotation', _quotation_at: quotationAt, _quote_version: data.quote_version ?? null,
  }
  const items = revItems.length
    ? revItems.map((it, i) => (i === 0 ? { ...it, _cost_breakdown: cb } : it))
    : [{ _cost_breakdown: cb }]
  const patch: Record<string, unknown> = { items }
  if ((!bo?.total_revenue || Number(bo.total_revenue) === 0) && revenueTotal > 0) patch.total_revenue = revenueTotal
  const { error } = await supabase.from('budget_orders').update(patch).eq('id', budgetOrderId)
  if (error) throw new Error(`预算自动填充失败: ${error.message}`)
  return { action: 'done', reason: `报价冻结→预算已填 order=${orderNo} · ${Object.values(lines).flat().length} 行 · 核算日 ${quotationAt}${qtyUsed != null ? ` · 单件×数量${qtyUsed}` : ''}` }
}

// --- 采购核料预算即时更新 → 财务 draft 预算(2026-07-08)---
// 节拍器弃用报价单识别后,业务在「采购核料」按真实物料填预算,保存即推本事件(内容哈希幂等,改了才更新)。
// 契约:data = { qimo_order_id, order_no, internal_order_no?, currency, quantity?,
//   budget_totals: { fabric_amount, cmt_amount, accessory_amount, total },   // 绝对总额(CNY,权威口径)
//   unit_costs?: {...元/件, 仅参考}, source:'procurement_verify' }
// 只填 draft 预算(已审批/锁定不覆盖);写法与 quotation.frozen 的 _cost_breakdown 同构(桶标量=明细之和),
// 但绝对总额直接入桶,不走"单件×数量"(逐款件数不一会漂),且不碰 synced_orders 的报价审计字段。
async function handleOrderBudgetUpdated(data: Record<string, unknown>) {
  const supabase = createServiceClient()
  const qimoOrderId = (data.qimo_order_id as string) || ''
  const orderNo = (data.order_no as string) || ''
  if (!qimoOrderId && !orderNo) return { action: 'ignored', reason: 'order.budget_updated 缺 qimo_order_id/order_no' }

  const bt = (data.budget_totals as Record<string, unknown>) || {}
  const at = (data.actual_totals as Record<string, unknown>) || {}
  const r2 = (n: number) => Math.round(n * 100) / 100
  const fabric = r2(Number(bt.fabric_amount) || 0)
  const accessory = r2(Number(bt.accessory_amount) || 0)
  const processing = r2(Number(bt.cmt_amount) || 0)   // 加工费 → processing 桶
  // 采购填价(采购核料按真实物料填的单价×数量)——财务看 原辅料 预算(报价) vs 采购价。2026-07-09 扩到面料/加工。
  const actualAccessory = r2(Number(at.accessory_amount) || 0)
  const actualFabric = r2(Number(at.fabric_amount) || 0)
  const actualProcessing = r2(Number(at.cmt_amount) || 0)   // 加工费采购填价
  if (fabric + accessory + processing + actualAccessory + actualFabric + actualProcessing <= 0) return { action: 'ignored', reason: 'order.budget_updated 预算/实际均为 0,跳过' }

  // 1. 定位 budget_order:优先 qimo_order_id(结构化),退回 synced_orders.order_no → budget_order_id
  let budgetOrderId: string | null = null
  if (qimoOrderId) {
    const { data: bo } = await supabase.from('budget_orders').select('id').eq('qimo_order_id', qimoOrderId).is('deleted_at', null).maybeSingle()
    budgetOrderId = bo?.id ?? null
  }
  if (!budgetOrderId && orderNo) {
    const { data: so } = await supabase.from('synced_orders').select('budget_order_id').eq('order_no', orderNo).not('budget_order_id', 'is', null).maybeSingle()
    budgetOrderId = (so?.budget_order_id as string) ?? null
  }
  // 尚未建预算单 → 自动建一张 draft 预算单再填(2026-07-09)。此前只寄存不落库 → 业务在采购核料填的
  // 预算永远到不了财务、三端(采购核料/采购下单/财务)口径对不上,预算控制失去意义。数字全来自本事件
  // (源头=业务采购核料),财务不自造数;只建 draft(不审批/不入账),与 autoCreateBudgetDraft 同一系统同步口径(created_by=null)。
  if (!budgetOrderId) {
    const { data: so } = await supabase.from('synced_orders')
      .select('id, order_no, customer_name, currency, total_amount, unit_price, quantity, budget_order_id, lifecycle_status')
      .eq(qimoOrderId ? 'id' : 'order_no', qimoOrderId || orderNo).maybeSingle()
    if (!so) return { action: 'ignored', reason: `预算已收到,但订单未同步到财务(order=${orderNo})——待订单同步后重推` }
    if (so.budget_order_id) {
      budgetOrderId = so.budget_order_id as string   // 竞态:order.created/activated 已建单 → 直接用
    } else {
      // 死单(已取消/删除/完成/归档)不自动建预算单 —— 死单进财务预算不干净;正常业务不会给死单改预算,此为防御。
      const DEAD = ['cancelled', 'deleted', 'completed', 'archived', '已取消', '已删除', '已完成', '已归档']
      if (DEAD.includes(String(so.lifecycle_status || '')))
        return { action: 'ignored', reason: `预算已收到,但订单为「${so.lifecycle_status}」(死单),不自动建预算单(order=${orderNo})` }
      const cleanName = String(so.customer_name || '').trim()
      if (!cleanName) return { action: 'ignored', reason: `预算已收到,但订单无客户名、无法建预算单(order=${orderNo})` }
      const { data: cust, error: custErr } = await supabase.rpc('get_or_create_customer' as never, {
        p_name: cleanName, p_currency: (so.currency as string) || 'CNY',
      } as never) as { data: { id?: string } | null; error: { message: string } | null }
      if (custErr || !cust?.id) return { action: 'ignored', reason: `预算已收到,但客户匹配失败(order=${orderNo}):${custErr?.message || '无客户'}` }
      const revenue = Number(so.total_amount) || (Number(so.unit_price || 0) * Number(so.quantity || 0)) || 0
      // order_no='' → 触发器自动生成 BO 号;金额桶待下方步骤 3 用事件预算填 items[0]._cost_breakdown
      const { data: created, error: insErr } = await supabase.from('budget_orders').insert({
        order_no: '', qimo_order_id: qimoOrderId || (so.id as string), customer_id: cust.id,
        total_revenue: revenue, currency: (so.currency as string) || 'CNY',
        status: 'draft', created_by: null, has_sub_documents: false,
        notes: `来源: 采购核料预算自动建单(节拍器 order.budget_updated)\n节拍器订单号: ${orderNo || ''}`,
      }).select('id').single()
      if (insErr || !created) {
        // 并发已建(qimo_order_id 唯一索引冲突)→ 重读用现有,不重复建
        const { data: exist } = await supabase.from('budget_orders').select('id')
          .eq('qimo_order_id', qimoOrderId || (so.id as string)).is('deleted_at', null).maybeSingle()
        if (exist?.id) budgetOrderId = exist.id
        else throw new Error(`预算单自动创建失败: ${insErr?.message || 'unknown'}`)
      } else {
        // 原子认领 synced_orders.budget_order_id;并发落败 → 软删本行、用胜者(与 autoCreateBudgetDraft 同一防护)
        const { data: claim } = await supabase.from('synced_orders')
          .update({ budget_order_id: created.id }).eq('id', so.id).is('budget_order_id', null).select('id')
        if (!claim || claim.length === 0) {
          await supabase.from('budget_orders').update({
            deleted_at: new Date().toISOString(), delete_reason: '并发重复草稿自动清理(采购核料预算建单落败)',
          }).eq('id', created.id)
          const { data: winner } = await supabase.from('synced_orders').select('budget_order_id').eq('id', so.id).maybeSingle()
          budgetOrderId = (winner?.budget_order_id as string) ?? null
        } else {
          budgetOrderId = created.id
        }
      }
    }
    if (!budgetOrderId) return { action: 'ignored', reason: `预算单创建落败且无胜者(order=${orderNo}),下次重推` }
  }

  // 2. 只填 draft 预算,不覆盖已审批/锁定(与 quotation.frozen 同一保守口径)
  const { data: bo } = await supabase.from('budget_orders').select('status, total_revenue, items').eq('id', budgetOrderId).maybeSingle()
  if (bo && bo.status !== 'draft') {
    await logFinancialDrop('order.budget_updated', orderNo || qimoOrderId, `采购核料预算/采购填价已收到,但预算单非 draft(${bo?.status})未自动覆盖、新数据未入账(order=${orderNo || qimoOrderId}),请财务核对是否需人工更新预算`)
    return { action: 'ok', reason: `预算单非 draft(${bo?.status}),不自动覆盖` }
  }

  // 3. 绝对总额 → _cost_breakdown 三桶(桶标量=该桶明细之和,维持不变量)
  const mkLine = (name: string, amount: number) => amount > 0 ? [{ name, qty: 0, unit: '', unit_price: 0, amount }] : []
  const lines: Record<string, unknown[]> = {
    fabric: mkLine('面料预算(采购核料)', fabric),
    accessory: mkLine('辅料预算(采购核料)', accessory),
    processing: mkLine('加工费预算(采购核料)', processing),
  }
  const currency = (data.currency as string) || 'CNY'
  const cb = {
    fabric, accessory, processing, forwarder: 0, container: 0, logistics: 0,
    extras: [], lines,
    _currency: 'CNY',
    _revenue_input: Number(bo?.total_revenue) || 0,
    _revenue_currency: currency,
    _rate: data.exchange_rate != null ? Number(data.exchange_rate) : (currency === 'CNY' ? 1 : null),
    _source: 'qimo_procurement_budget',
    _budget_updated_at: new Date().toISOString(),
    // 采购填价(采购核料按真实物料填的单价×数量)——财务看 原辅料 预算(报价) vs 采购价。
    // 2026-07-08 辅料先行,2026-07-09 扩到面料/加工(节拍器 actual_totals 需带 fabric_amount/cmt_amount)。
    _actual_accessory: actualAccessory || null,
    _actual_fabric: actualFabric || null,
    _actual_processing: actualProcessing || null,
  }
  // 保留已有 items 的收入行(如 SKU 款号行),只替换首行的 _cost_breakdown 载体
  const existingItems = Array.isArray((bo as { items?: unknown })?.items) ? ((bo as { items?: unknown[] }).items as unknown[]) : []
  const items = existingItems.length
    ? existingItems.map((it, i) => (i === 0 ? { ...(it as Record<string, unknown>), _cost_breakdown: cb } : it))
    : [{ _cost_breakdown: cb }]
  const { error } = await supabase.from('budget_orders').update({ items }).eq('id', budgetOrderId)
  if (error) throw new Error(`采购核料预算填充失败: ${error.message}`)
  return { action: 'done', reason: `采购核料预算已填 order=${orderNo || qimoOrderId} · 面料 ${fabric} / 加工 ${processing} / 辅料预算 ${accessory} / 辅料实际 ${actualAccessory}` }
}

// --- 出货发票金额 → 应收(2026-07-10)---
// 节拍器出运完成推累计 CI 金额(整单口径,已含各批)。语义(用户拍板):
//   budget_order = draft 未确认 → 以 CI 金额更新 total_revenue(应收),shipping_invoice.booked=true;
//   已确认(approved/rejected/closed 等)→ 只存 shipping_invoice 快照 + 记 integration_logs 告警,绝不自动改账。
// 契约:data = { qimo_order_id, order_no, internal_order_no?, currency, invoice_amount,
//   invoice_qty?, deposit_raw?(PI 定金原文), scopes:[{scope,amount,qty}], source:'qimo_shipping_ci' }
async function handleShippingInvoiceIssued(data: Record<string, unknown>) {
  const supabase = createServiceClient()
  const qimoOrderId = (data.qimo_order_id as string) || ''
  const orderNo = (data.order_no as string) || ''
  if (!qimoOrderId && !orderNo) return { action: 'ignored', reason: 'shipping_invoice.issued 缺 qimo_order_id/order_no' }

  const r2 = (n: unknown) => { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0 }
  const invoiceAmount = r2(data.invoice_amount)
  if (invoiceAmount <= 0) return { action: 'ignored', reason: 'shipping_invoice.issued 金额≤0,跳过' }
  const currency = (data.currency as string) || 'USD'

  // 定位 budget_order:优先 qimo_order_id(结构化),退回 synced_orders.order_no → budget_order_id
  let budgetOrderId: string | null = null
  if (qimoOrderId) {
    const { data: bo } = await supabase.from('budget_orders').select('id').eq('qimo_order_id', qimoOrderId).is('deleted_at', null).maybeSingle()
    budgetOrderId = bo?.id ?? null
  }
  if (!budgetOrderId && orderNo) {
    const { data: so } = await supabase.from('synced_orders').select('budget_order_id').eq('order_no', orderNo).not('budget_order_id', 'is', null).maybeSingle()
    budgetOrderId = (so?.budget_order_id as string) ?? null
  }
  if (!budgetOrderId) {
    // CI 是出运下游,预算单本应先于出运存在。未建 → 不自动建(避免死单/脏数据),记告警待人工。
    await supabase.from('integration_logs').insert({
      event_type: 'shipping_invoice.no_budget', direction: 'inbound',
      request_id: `ci-nobudget-${qimoOrderId || orderNo}-${Date.now()}`, source: 'order-metronome', status: 'warning',
      payload_summary: `出货 CI=${invoiceAmount} ${currency} 已收到,但订单 ${orderNo || qimoOrderId} 尚未建预算单,应收未入账,请财务确认`,
    })
    return { action: 'ok', reason: `CI 已收到但订单未建预算单(order=${orderNo || qimoOrderId}),已记告警待人工` }
  }

  const { data: bo } = await supabase.from('budget_orders').select('status, total_revenue').eq('id', budgetOrderId).maybeSingle()
  const prev = Number(bo?.total_revenue) || 0
  const snapshotBase = {
    invoice_amount: invoiceAmount,
    currency,
    deposit_raw: (data.deposit_raw as string) ?? null,
    invoice_qty: data.invoice_qty != null ? Number(data.invoice_qty) : null,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    received_at: new Date().toISOString(),
    source: 'qimo_shipping_ci',
    prev_total_revenue: prev,
  }

  if (bo && bo.status === 'draft') {
    // P0-3:CI 把币种改成外币时,必须同步汇率。否则订单原 exchange_rate 停留在旧值(如 CNY 的 1),
    // 下游 safeRate 会把这个 stale=1 当有效 → 美金收入按 ×1 少算几十万。CI 带汇率则用,否则置 null(→ safeRate 兜底按7+告警)。
    const ciRate = currency === 'CNY' ? 1 : (data.exchange_rate != null ? Number(data.exchange_rate) : null)
    const { error } = await supabase.from('budget_orders').update({
      total_revenue: invoiceAmount,
      currency,
      exchange_rate: ciRate,
      shipping_invoice: { ...snapshotBase, booked: true },
    }).eq('id', budgetOrderId)
    if (error) throw new Error(`应收(total_revenue)更新失败: ${error.message}`)
    return { action: 'done', reason: `draft 应收以 CI 更新 order=${orderNo || qimoOrderId} ${prev}→${invoiceAmount} ${currency}` }
  }

  // 已确认(非 draft)→ 只存快照 + 差异告警,绝不改账
  const { error } = await supabase.from('budget_orders').update({
    shipping_invoice: { ...snapshotBase, booked: false },
  }).eq('id', budgetOrderId)
  if (error) throw new Error(`出货 CI 快照写入失败: ${error.message}`)
  const diff = Math.round((invoiceAmount - prev) * 100) / 100
  if (Math.abs(diff) > 0.01) {
    await supabase.from('integration_logs').insert({
      event_type: 'shipping_invoice.diff', direction: 'inbound',
      request_id: `ci-diff-${budgetOrderId}-${Date.now()}`, source: 'order-metronome', status: 'warning',
      payload_summary: `订单 ${orderNo || qimoOrderId} 出货 CI=${invoiceAmount} ${currency} ≠ 已确认应收=${prev}(预算单 ${bo?.status}),差 ${diff},请财务确认是否人工调整——未自动改账`,
    })
  }
  return { action: 'ok', reason: `预算单非 draft(${bo?.status}),CI=${invoiceAmount} 只存快照未改账${Math.abs(diff) > 0.01 ? `(差 ${diff} 已告警)` : ''}` }
}

async function handleSupplierUpsert(data: Record<string, unknown>) {
  const supabase = createServiceClient()
  const name = String(data.name || '').trim()
  if (!name) return { action: 'ignored', reason: 'supplier.upserted 缺少 name' }
  const qimoId = data.supplier_id ? String(data.supplier_id) : ''
  const srcLine = `节拍器供应商同步 · qimo_id=${qimoId} · 类目=${String(data.main_category || '') || '—'} · 状态=${String(data.status || '') || '—'}`

  const { data: existing } = await supabase.from('suppliers')
    .select('id, notes').eq('name', name).is('deleted_at', null).maybeSingle()

  if (existing) {
    // 已存在：仅在 notes 未含该 qimo_id 溯源时补一行，绝不覆盖已有资料
    const notes = String(existing.notes || '')
    if (qimoId && !notes.includes(qimoId)) {
      await supabase.from('suppliers')
        .update({ notes: notes ? `${notes}\n${srcLine}` : srcLine, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { action: 'supplier_exists', supplier_id: existing.id, name }
  }

  const bankInfo = data.bank_info
  const { data: created, error } = await supabase.from('suppliers').insert({
    name,
    bank_name: bankInfo && typeof bankInfo === 'object' ? (bankInfo as Record<string, string>).bank_name ?? null : null,
    account_no: bankInfo && typeof bankInfo === 'object' ? (bankInfo as Record<string, string>).account_no ?? null : null,
    account_name: bankInfo && typeof bankInfo === 'object' ? (bankInfo as Record<string, string>).account_name ?? null : null,
    notes: srcLine,
  }).select('id').single()
  if (error) throw new Error(`supplier upsert 失败: ${error.message}`)
  return { action: 'supplier_created', supplier_id: created.id, name }
}

// --- 订单同步 ---
async function handleOrderSync(order: SyncedOrder, event: string) {
  const supabase = createServiceClient()

  // Upsert 同步订单
  const { error } = await supabase
    .from('synced_orders')
    .upsert({
      id: order.id,
      order_no: order.order_no,
      customer_name: order.customer_name,
      incoterm: order.incoterm,
      delivery_type: order.delivery_type,
      order_type: order.order_type,
      lifecycle_status: order.lifecycle_status,
      po_number: order.po_number,
      currency: order.currency,
      unit_price: order.unit_price,
      total_amount: order.total_amount,
      quantity: order.quantity,
      quantity_unit: order.quantity_unit,
      factory_name: order.factory_name,
      etd: order.etd,
      payment_terms: order.payment_terms,
      style_no: order.style_no,
      notes: order.notes,
      source_created_by: order.created_by,
      source_created_at: order.created_at,
      source_updated_at: order.updated_at,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`Sync failed: ${error.message}`)

  // 新订单自动创建预算单草稿（Wave 1-B 加固：所有路径都持久化 budget_sync_status，无 silent failure）
  let budgetSync: { status: string; budget_order_id?: string; error?: string } | null = null
  if (event === 'order.created' || event === 'order.activated') {
    budgetSync = await autoCreateBudgetDraft(order)
    // 失败必须写诊断日志（No Silent Financial Failure）
    if (budgetSync.status === 'draft_failed') {
      await supabase.from('save_diagnostic_logs').insert({
        action: 'auto_create',
        table_name: 'budget_orders',
        record_id: order.id,
        source_page: 'webhook',
        status: 'error',
        error_detail: `auto-budget 失败 [synced_order=${order.order_no}]: ${budgetSync.error}`,
        actor_id: null,
      })
    }
  }

  return { action: 'synced', order_no: order.order_no, event, budget_sync: budgetSync }
}

// --- 订单状态变更 ---
async function handleOrderStatusChange(order: SyncedOrder, event: string) {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('synced_orders')
    .update({
      lifecycle_status: order.lifecycle_status,
      source_updated_at: order.updated_at,
      synced_at: new Date().toISOString(),
    })
    .eq('id', order.id)

  if (error) throw new Error(`Status update failed: ${error.message}`)
  return { action: 'status_updated', order_no: order.order_no, status: order.lifecycle_status, event }
}

// --- 删单/取消 → 保守冲销（审计 C1）---
// 保守口径(用户拍板):作废未确认的预算草稿(soft-delete) + 撤未决审批;已确认预算/
// 应付/已过账凭证只记录待人工红冲,绝不自动改已入账数据。每步 try/catch,任一步失败
// 不阻断其余、不抛出(避免单个 order.deleted 处理异常 500;warnings 随响应回给节拍器)。
async function handleOrderReversal(order: SyncedOrder, event: string) {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const warnings: string[] = []
  const actions: string[] = []

  // 1. 镜像状态
  try {
    await supabase.from('synced_orders').update({
      lifecycle_status: order.lifecycle_status || (event === 'order.deleted' ? 'deleted' : 'cancelled'),
      source_updated_at: order.updated_at ?? null,
      synced_at: now,
    }).eq('id', order.id)
    actions.push('镜像状态已更新')
  } catch (e) { warnings.push(`镜像状态更新失败: ${e instanceof Error ? e.message : e}`) }

  // 2. 关联预算
  let budgetId: string | null = null
  try {
    const { data: so } = await supabase.from('synced_orders').select('budget_order_id').eq('id', order.id).maybeSingle()
    budgetId = (so as { budget_order_id?: string } | null)?.budget_order_id ?? null
  } catch { /* ignore */ }

  if (budgetId) {
    try {
      const { data: bo } = await supabase.from('budget_orders').select('id, status, deleted_at').eq('id', budgetId).maybeSingle()
      const b = bo as { status?: string; deleted_at?: string } | null
      if (b && !b.deleted_at) {
        if (b.status === 'draft') {
          // 草稿从未确认 → soft-delete 作废（budget_orders 无 cancelled 状态;硬删守卫只拦物理 DELETE,UPDATE deleted_at 放行）
          const { error } = await supabase.from('budget_orders')
            .update({ deleted_at: now, delete_reason: `订单${event === 'order.deleted' ? '删除' : '取消'}自动冲销(节拍器同步)` })
            .eq('id', budgetId).is('deleted_at', null).eq('status', 'draft')
          if (error) warnings.push(`预算草稿作废失败,需人工处理: ${error.message}`)
          else actions.push('预算草稿已作废(soft-delete)')
        } else {
          warnings.push(`预算单 ${budgetId} 状态=${b.status}(非草稿,含已确认数据),需人工红冲——未自动改账`)
        }
      }
    } catch (e) { warnings.push(`预算处理异常: ${e instanceof Error ? e.message : e}`) }

    // 应付:保守——不自动动,有则标记待人工
    try {
      const { data: pays } = await supabase.from('payable_records')
        .select('id').eq('budget_order_id', budgetId).is('deleted_at', null).limit(1)
      if (pays && pays.length) warnings.push('存在应付记录,需人工红冲——未自动改')
    } catch { /* ignore */ }
  }

  // 2.6 已同步的采购单:订单删/取消 → 级联处理关联采购单(匹配 po_nos ∪ order_refs 含本订单 id)。
  //   未决(pending/pending_approval)→ 自动 soft-delete 撤销(订单都没了,财务没得审;移出采购审批队列);
  //   已批/已付(approved/paid)→ 仅警告需人工红冲,绝不自动动已入账/已出款。
  // (fin_purchase_orders 不挂 budget_order_id,靠 order_refs 里的 synced_orders.id 关联。)
  try {
    const poNos = Array.isArray((order as unknown as { po_nos?: unknown[] }).po_nos)
      ? ((order as unknown as { po_nos?: unknown[] }).po_nos as unknown[]).map(String).map(s => s.trim()).filter(Boolean)
      : []
    // 匹配关联采购单:po_no ∪ order_refs 含本订单 id。order_refs 两种历史格式都覆盖:
    //   旧=["<uuid>"](字符串数组)、新(2026-07-09)=[{id,order_no,internal_order_no,...}](对象数组)。
    // 分开查再按 id 去重(避免 .or 里塞 jsonb 对象字面量的转义脆弱性)。
    type FPo = { id: string; po_no?: string; fin_status?: string }
    const collected = new Map<string, FPo>()
    const add = (arr: FPo[] | null) => { for (const p of arr || []) collected.set(p.id, p) }
    if (poNos.length) {
      const { data } = await supabase.from('fin_purchase_orders')
        .select('id, po_no, fin_status').in('po_no', poNos).is('deleted_at', null)
      add(data as FPo[] | null)
    }
    for (const pat of [[order.id] as unknown, [{ id: order.id }] as unknown]) {
      const { data } = await supabase.from('fin_purchase_orders')
        .select('id, po_no, fin_status').contains('order_refs', pat as never).is('deleted_at', null)
      add(data as FPo[] | null)
    }
    const list = [...collected.values()]
    const undecided = list.filter(p => p.fin_status === 'pending' || p.fin_status === 'pending_approval')
    const decided = list.filter(p => p.fin_status === 'approved' || p.fin_status === 'paid')
    if (undecided.length) {
      // soft-delete 即移出采购审批队列(getPendingPurchaseApprovals 过滤 deleted_at is null);
      // 不动 fin_status(CHECK 约束无 'cancelled';且语义上是"订单没了作废",非财务驳回),用 approval_note 留因。
      const { error } = await supabase.from('fin_purchase_orders')
        .update({ deleted_at: now, approval_note: `订单${event === 'order.deleted' ? '删除' : '取消'}自动撤销(节拍器同步)`, updated_at: now })
        .in('id', undecided.map(p => p.id))
      if (error) warnings.push(`采购单撤销失败,需人工: ${error.message}`)
      else actions.push(`撤销 ${undecided.length} 张未决采购审批(${undecided.map(p => p.po_no).join('、')})`)
    }
    if (decided.length) {
      warnings.push(`存在 ${decided.length} 张已批/已付采购单(${decided.map(p => p.po_no).join('、')}),订单已${event === 'order.deleted' ? '删除' : '取消'},其采购应付需人工红冲——未自动改`)
    }
  } catch (e) { warnings.push(`采购单级联处理异常: ${e instanceof Error ? e.message : e}`) }

  // 3. 撤未决审批。⚠️ pending_approvals.status CHECK 不含 'cancelled'(会 23514 静默失败→审批撤不掉、积压堆积);
  //    合法终态用 'expired'(2026-07-09 实测)。留因可追溯。
  try {
    const { data: expired, error: exErr } = await supabase.from('pending_approvals')
      .update({ status: 'expired', decided_at: now, decider_name: '系统', decision_note: `订单${event === 'order.deleted' ? '删除' : '取消'}自动撤销未决审批(节拍器同步)` })
      .eq('order_no', order.order_no).eq('status', 'pending').select('id')
    if (exErr) warnings.push(`撤审批失败: ${exErr.message}`)
    else if (expired && expired.length) actions.push(`撤销 ${expired.length} 条未决审批`)
  } catch (e) { warnings.push(`撤审批失败: ${e instanceof Error ? e.message : e}`) }

  // 3.5 兜底(问题2 · 切片4):订单被节拍器取消/删除,但仍含【已审批/已动钱】数据(🟡/🔴)→
  //   不再只写 warning 让财务看不到,而是建一条 source=metronome 的作废申请进【作废审批队列】,
  //   由财务终审(级联软删/驳回)。根治「取消审批被节拍器同步秒过期、财务永远看不到」#3。
  //   仅 severity≠clean 才建(clean 单上面已保守作废);幂等——每单同时只一个 pending(唯一索引兜底)。
  if (budgetId) {
    try {
      const report = await preflightOrderVoid(supabase, budgetId)
      if (report.severity !== 'clean') {
        const { data: exist } = await supabase.from('order_void_requests')
          .select('id').eq('budget_order_id', budgetId).eq('status', 'pending').maybeSingle()
        if (!exist) {
          const { error: vErr } = await supabase.from('order_void_requests').insert({
            budget_order_id: budgetId,
            order_no: report.orderNo,
            qm_order_no: report.qmOrderNo || order.order_no,
            internal_no: report.internalNo,
            source: 'metronome',
            reason: `节拍器${event === 'order.deleted' ? '删除' : '取消'}订单,含已审批数据,待财务终审`,
            severity: report.severity,
            blockers: report.items,
            status: 'pending',
            requested_by_name: '节拍器',
          })
          if (vErr) warnings.push(`转作废队列失败,需人工: ${vErr.message}`)
          else actions.push('已转财务作废队列待终审(含已审批数据)')
        } else {
          actions.push('作废申请已存在(幂等跳过)')
        }
      }
    } catch (e) { warnings.push(`转作废队列失败: ${e instanceof Error ? e.message : e}`) }
  }

  // 4. 需人工处理 → 记审计日志(失败不阻断)
  if (warnings.length) {
    try {
      await supabase.from('integration_logs').insert({
        event_type: `${event}.manual_review`,
        direction: 'inbound',
        status: 'warning',
        payload: { order_id: order.id, order_no: order.order_no, budget_order_id: budgetId, warnings },
      } as never)
    } catch { /* ignore */ }
  }

  return { action: 'order_reversed', event, order_no: order.order_no, actions, warnings }
}

// --- 采购对账付款申请入账(2026-07-11 P2 财务侧)---
// source_ref=节拍器付款申请id,幂等。detail.lines 存采购订单/供应商对账明细,供付款审批页核对实际付款。
async function handlePayableCreated(data: Record<string, unknown>, _requestId: string) {
  const supabase = createServiceClient()
  const sourceRef = String(data.source_ref || '')
  if (!sourceRef) return { action: 'ignored', reason: 'payable.created 缺 source_ref' }
  const num = (v: unknown) => (v == null ? 0 : Number(v))

  const row: Record<string, unknown> = {
    source_ref: sourceRef,
    supplier_name: (data.supplier_name as string) || '(未标注供应商)',   // NOT NULL
    description: (data.description as string) || '采购对账付款',           // NOT NULL
    order_no: (data.po_no as string) || null,
    cost_category: 'raw_material',
    amount: num(data.amount),                                              // NOT NULL
    currency: (data.currency as string) || 'CNY',
    bill_no: (data.bill_no as string) || null,
    due_date: (data.due_date as string) || null,
    payment_status: 'unpaid',
    detail: {
      lines: Array.isArray(data.lines) ? data.lines : [],
      order_refs: Array.isArray(data.order_refs) ? data.order_refs : [],
      reconciliation_id: (data.reconciliation_id as string) ?? null,
      purchase_order_id: (data.purchase_order_id as string) ?? null,
    },
  }

  // 幂等:先按 source_ref 查(局部唯一索引 where source_ref not null and deleted_at is null)
  const { data: existing } = await supabase.from('payable_records')
    .select('id, payment_status').eq('source_ref', sourceRef).is('deleted_at', null).maybeSingle()
  if (existing) {
    // 已入账:仅在未付/待审时刷新金额与明细(已付/已批不覆盖,防回改已决记录)
    if (['unpaid', 'pending_approval'].includes((existing as { payment_status: string }).payment_status)) {
      const { error } = await supabase.from('payable_records')
        .update({ ...row, updated_at: new Date().toISOString() }).eq('id', (existing as { id: string }).id)
      if (error) throw new Error(`payable 更新失败: ${error.message}`)
    }
    return { action: 'payable_updated', source_ref: sourceRef }
  }
  const { error } = await supabase.from('payable_records').insert(row)
  if (error) throw new Error(`payable 入账失败: ${error.message}`)
  return { action: 'payable_created', source_ref: sourceRef, supplier: row.supplier_name }
}

// --- 价格审批请求 ---
async function handlePriceApprovalRequest(req: PriceApprovalRequest) {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('pending_approvals')
    .upsert({
      id: req.id,
      approval_type: 'price',
      order_no: req.order_no,
      customer_name: req.customer_name,
      requested_by_name: req.requester_name,
      summary: req.summary,
      detail: req.price_diffs,
      form_snapshot: req.form_snapshot,
      expires_at: req.expires_at,
      status: 'pending',
      source_created_at: req.created_at,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`Price approval sync failed: ${error.message}`)
  return { action: 'approval_queued', type: 'price', order_no: req.order_no }
}

// (handleDelayApprovalRequest 已移除 2026-07-09:节拍器改期只走内部审批、从不推 delay.requested,幽灵能力删除)

// --- 取消订单 / 里程碑 财务审批请求(通用)---
// 节拍器发起,财务在审批队列批/驳 → 现有 approve 路由透传 approval_type 回传节拍器 finance-callback。
// 载荷通用字段:id(必) / order_no / customer_name / requester_name / summary / detail / created_at。
async function handleGenericApprovalRequest(data: Record<string, unknown>, type: 'cancel' | 'milestone' | 'shipment') {
  const supabase = createServiceClient()
  const id = String(data.id || data.approval_id || '')
  if (!id) throw new Error(`${type}.requested 缺少 id`)
  // ⚠️ pending_approvals.order_no / requested_by_name / summary 均为 NOT NULL。节拍器可能传空
  // (如申请人 profiles.name 未设 → requester_name 为 null)→ 若写 null 会 insert 失败、审批静默丢。
  // 一律给安全兜底,保证审批必落库(宁可显示"未标注",也不能丢)。
  const { error } = await supabase.from('pending_approvals').upsert({
    id,
    approval_type: type,
    order_no: (data.order_no as string) || (data.po_no as string) || '(未标注订单)',
    customer_name: (data.customer_name as string) ?? null,
    requested_by_name: (data.requester_name as string) || (data.requested_by_name as string) || '节拍器申请',
    summary: (data.summary as string) || (
      type === 'cancel' ? '取消订单待财务审批'
      : type === 'shipment' ? '出货待财务审批'
      : '里程碑待财务确认'),
    detail: (data.detail as Record<string, unknown>) ?? data,
    expires_at: (data.expires_at as string) ?? null,
    status: 'pending',
    source_created_at: (data.created_at as string) ?? null,
    synced_at: new Date().toISOString(),
  }, { onConflict: 'id' })
  if (error) throw new Error(`${type} approval sync failed: ${error.message}`)
  return { action: 'approval_queued', type, order_no: (data.order_no as string) ?? null }
}

// --- 出货申请撤回:未决审批置 expired(pending_approvals CHECK 无 'cancelled',合法终态用 'expired') ---
async function handleShipmentApprovalCancelled(data: Record<string, unknown>) {
  const supabase = createServiceClient()
  const id = String(data.id || data.approval_id || '')
  if (!id) throw new Error('shipment_approval.cancelled 缺少 id')
  // 只动未决(pending)的行;财务已批/驳的不覆盖(节拍器侧撤回闸已挡竞态,这里再兜一层)
  const { data: upd, error } = await supabase.from('pending_approvals')
    .update({
      status: 'expired',
      decided_at: new Date().toISOString(),
      decider_name: '节拍器',
      decision_note: `业务撤回出货申请${data.reason ? `: ${data.reason}` : ''}`,
    })
    .eq('id', id).eq('approval_type', 'shipment').eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`shipment approval cancel failed: ${error.message}`)
  return { action: upd && upd.length ? 'approval_cancelled' : 'ignored_already_decided', id }
}

// --- 文件上传同步 ---
// 契约扩展(2026-07-11 PO审批附件链):data 可带
//   purchase_order_id — 该文件属于哪张采购单(fin_purchase_orders.purchase_order_id)
//   order_id          — 该文件属于哪个节拍器订单(synced_orders.id)
//   doc_hint          — 节拍器侧已知类型:'po' | 'internal_quote' | 其他
// 带 doc_hint 的关联附件置 status='pending'(待财务在采购审批页触发识别),其余保持 confirmed。
async function handleFileUpload(data: Record<string, unknown>) {
  const supabase = createServiceClient()

  const docHint = (data.doc_hint as string) || null
  const relatedPo = data.purchase_order_id ? String(data.purchase_order_id) : null
  const { error } = await supabase
    .from('uploaded_documents')
    .upsert({
      id: data.id as string,
      file_name: (data.file_name as string) || 'unnamed',
      file_type: (data.file_type as string) || 'image',
      file_size: data.file_size as number || null,
      file_url: data.file_url as string || null,
      status: docHint ? 'pending' : 'confirmed',
      extracted_fields: data.extracted_fields || {},
      matched_customer: (data.matched_customer as string) || null,
      related_purchase_order_id: relatedPo,
      related_qimo_order_id: (data.order_id as string) || null,
      doc_hint: docHint,
      created_at: (data.created_at as string) || new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`File sync failed: ${error.message}`)
  return { action: 'file_synced', file_name: data.file_name, related_po: relatedPo, doc_hint: docHint }
}

// --- 订单同步时自动创建预算单草稿 ---
// Wave 1-B 加固：所有出口都把 budget_sync_status 写回 synced_orders，
//                 永不 silent fail，永不 silent skip
type AutoBudgetResult = { status: string; budget_order_id?: string; error?: string }

async function markSyncStatus(
  supabase: ReturnType<typeof createServiceClient>,
  syncedOrderId: string,
  status: string,
  patch: Partial<{ budget_order_id: string; budget_sync_error: string | null }> = {},
) {
  await supabase.from('synced_orders').update({
    budget_sync_status: status,
    budget_sync_attempted_at: new Date().toISOString(),
    budget_sync_attempt_count: undefined as never, // 由下面 RPC 递增
    ...patch,
  }).eq('id', syncedOrderId)
  // 单独原子递增 attempt_count
  // Wave 1-E P0 修复: 不再字符串插值 syncedOrderId（即使来自有签名 webhook payload，
  // 财务系统也不允许 SQL 注入面）。改用参数化 RPC。
  await supabase.rpc('increment_sync_attempt' as never, { p_id: syncedOrderId } as never)
}

async function autoCreateBudgetDraft(order: SyncedOrder): Promise<AutoBudgetResult> {
  const supabase = createServiceClient()
  try {
    // ────────── 1. 业务规则：无金额则跳过（可解释） ──────────
    if (!order.total_amount && !order.unit_price) {
      await markSyncStatus(supabase, order.id, 'no_amount_skipped', { budget_sync_error: null })
      return { status: 'no_amount_skipped' }
    }

    // ────────── 2. 幂等：通过 synced_orders.budget_order_id 检查（不再用 ilike） ──────────
    const { data: synced } = await supabase
      .from('synced_orders').select('budget_order_id').eq('id', order.id).maybeSingle()
    if (synced?.budget_order_id) {
      // 审计 P1③:迟到金额提醒。绮陌先空头后补额/改额时,草稿已建会被幂等短路→金额永不回填、且无告警(低估收入)。
      // 若草稿仍是 draft 且绮陌金额与草稿不一致,记一条 integration_logs 警告交财务决定;绝不自动改 draft 以外的单。
      try {
        const incoming = Number(order.total_amount) || (Number(order.unit_price || 0) * Number(order.quantity || 0))
        const { data: bo } = await supabase.from('budget_orders').select('total_revenue, status').eq('id', synced.budget_order_id).maybeSingle()
        if (bo && bo.status === 'draft' && incoming > 0 && Math.abs((Number(bo.total_revenue) || 0) - incoming) > 0.01) {
          await supabase.from('integration_logs').insert({
            event_type: 'order.amount_diff', direction: 'inbound',
            request_id: `amt-diff-${order.id}-${Date.now()}`, source: 'order-metronome', status: 'warning',
            payload_summary: `订单 ${order.order_no} 绮陌金额=${incoming} ≠ 财务草稿=${bo.total_revenue}(草稿仍 draft)，请财务确认是否采纳新金额`,
          })
        }
      } catch (e) { console.error('[webhook] 金额 diff 检测失败:', e) }
      await markSyncStatus(supabase, order.id, 'draft_skipped', { budget_sync_error: null })
      return { status: 'draft_skipped', budget_order_id: synced.budget_order_id }
    }

    // ────────── 3. actor：系统同步路径无登录人，created_by 记 null ──────────
    // 旧实现取"第一个 profile"会把系统同步的单据伪造成某个真人创建（污染审计链）。
    // 来源已由 synced_orders / integration_logs 完整记录（metronome webhook）。
    const createdBy: string | null = null

    // ────────── 4. 查找或创建客户（注意：customers 不是受 trigger 保护的财务表） ──────────
    let customerId: string | null = null
    const cleanCustomerName = order.customer_name?.trim()  // 空白字符串视作未提供
    if (cleanCustomerName) {
      // 与手动同步同一 RPC(advisory lock 串行化 + 等值匹配)——此前 ilike %name% 子串匹配
      // 会把"ABC"挂到"ABC Group"，且并发下重复建客户(审计 P2)
      const { data: cust, error: custErr } = await supabase.rpc('get_or_create_customer' as never, {
        p_name: cleanCustomerName, p_currency: order.currency || 'USD',
      } as never) as { data: { id?: string } | null; error: { message: string } | null }
      if (custErr) throw new Error(`customer lookup failed: ${custErr.message}`)
      if (cust?.id) customerId = cust.id
    }
    if (!customerId) {
      await markSyncStatus(supabase, order.id, 'manual_review', {
        budget_sync_error: '无 customer_name 或客户匹配失败，已转人工',
      })
      return { status: 'manual_review', error: 'no customer info' }
    }

    // ────────── 5. Phase 3 Path A: 如果节拍器推了 quotation, 构建 _cost_breakdown ──────────
    const q = order.quotation
    const fabric = Number(q?.fabric_amount || 0)
    const accessory = Number(q?.accessory_amount || 0)
    const processing = Number(q?.processing_amount || 0)
    const forwarder = Number(q?.forwarder_amount || 0)
    const container = Number(q?.container_amount || 0)
    const logistics = Number(q?.logistics_amount || 0)
    const hasQuotation = fabric + accessory + processing + forwarder + container + logistics > 0
    const rate = Number(q?.exchange_rate || 0) || null

    const totalAmount = Number(order.total_amount) || (Number(order.unit_price || 0) * Number(order.quantity || 0))
    const totalCost = fabric + accessory + processing + forwarder + container + logistics
    const revenueCny = (order.currency || 'USD') === 'CNY' ? totalAmount : (rate ? totalAmount * rate : 0)
    const profit = revenueCny - totalCost
    const margin = revenueCny > 0 ? Math.round((profit / revenueCny) * 10000) / 100 : 0

    const itemsField = hasQuotation ? [{
      _cost_breakdown: {
        fabric, accessory, processing, forwarder, container, logistics,
        extras: q?.extras || [],
        _currency: 'CNY',
        _revenue_input: totalAmount,
        _revenue_currency: order.currency || 'USD',
        _rate: rate,
        _source: 'metronome_quotation',
        _quoted_at: q?._quoted_at || null,
      },
    }] : []

    const { data: created, error: insertErr } = await supabase.from('budget_orders').insert({
      order_no: '',
      qimo_order_id: order.id,   // 审计 P1:绮陌订单 UUID 结构化落库(不再只靠 synced_orders 中转+notes)
      customer_id: customerId,
      total_revenue: totalAmount,
      currency: order.currency || 'USD',
      exchange_rate: rate,
      items: itemsField as never,
      target_purchase_price: hasQuotation ? fabric + accessory : 0,
      estimated_freight: hasQuotation ? forwarder : 0,
      estimated_commission: hasQuotation ? processing : 0,
      total_cost: totalCost,
      estimated_profit: profit,
      estimated_margin: margin,
      product_name: q?.product_name || null,
      status: 'draft',
      created_by: createdBy,
      notes: `来源: 订单节拍器自动同步\n节拍器订单号: ${order.order_no}\n客户: ${cleanCustomerName || ''}\nPO: ${order.po_number || ''}${hasQuotation ? '\n报价已附带，含 _cost_breakdown' : '\n⚠ 节拍器未附带报价，需财务人工补充'}`,
      has_sub_documents: false,
    }).select('id').single()

    if (insertErr || !created) throw new Error(`budget_orders insert failed: ${insertErr?.message || 'unknown'}`)

    // 原子认领：并发(order.created 与 order.activated / 手动同步)下只允许一个草稿胜出。
    // 此前 check-then-insert 无锁，竞态会建出两张草稿(审计 P1)。财务表禁物理删，败者软删。
    const { data: claim } = await supabase.from('synced_orders')
      .update({ budget_order_id: created.id })
      .eq('id', order.id).is('budget_order_id', null)
      .select('id')
    if (!claim || claim.length === 0) {
      await supabase.from('budget_orders').update({
        deleted_at: new Date().toISOString(), delete_reason: '并发重复草稿自动清理(原子认领落败)',
      }).eq('id', created.id)
      const { data: winner } = await supabase.from('synced_orders').select('budget_order_id').eq('id', order.id).maybeSingle()
      await markSyncStatus(supabase, order.id, 'draft_skipped', { budget_sync_error: null })
      return { status: 'draft_skipped', budget_order_id: winner?.budget_order_id ?? undefined }
    }

    // 把 quotation 原始 payload 存进 synced_orders 做审计
    if (q) {
      await supabase.from('synced_orders').update({
        quotation_data: q as never,
        quotation_applied_at: new Date().toISOString(),
      }).eq('id', order.id)
    }

    await markSyncStatus(supabase, order.id, hasQuotation ? 'draft_created' : 'draft_created_no_quotation', {
      budget_order_id: created.id,
      budget_sync_error: null,
    })
    return { status: hasQuotation ? 'draft_created' : 'draft_created_no_quotation', budget_order_id: created.id }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markSyncStatus(supabase, order.id, 'draft_failed', { budget_sync_error: msg })
    return { status: 'draft_failed', error: msg }
  }
}

// --- 记录集成日志 ---
async function logIntegrationEvent(
  payload: WebhookPayload,
  direction: 'inbound' | 'outbound',
  status: 'success' | 'failed',
  errorMessage?: string
) {
  try {
    const supabase = createServiceClient()
    await supabase.from('integration_logs').insert({
      event_type: payload.event,
      direction,
      request_id: payload.request_id,
      source: payload.source,
      status,
      payload_summary: JSON.stringify(payload.data).slice(0, 500),
      error_message: errorMessage || null,
    })
  } catch (e) {
    console.error('[Webhook] Failed to log event:', e)
  }
}

// P0-1(2026-07-10 止血静默丢弃):财务事件被丢弃/跳过(action:'ok' 但数据未入账)时,
// 必留一条可查的告警痕迹(status='warning'),杜绝「悄悄扔了还不告诉你」。落 integration_logs,
// 供异常中心/通知铃(P0-2)浮现。key 用订单号等业务键,便于人工定位。
async function logFinancialDrop(eventType: string, key: string, summary: string) {
  try {
    const supabase = createServiceClient()
    await supabase.from('integration_logs').insert({
      event_type: eventType,
      direction: 'inbound',
      request_id: `drop-${eventType}-${key || 'na'}-${Date.now()}`,
      source: 'order-metronome',
      status: 'warning',
      payload_summary: summary.slice(0, 500),
    })
  } catch (e) {
    console.error('[Webhook] Failed to log financial drop:', e)
  }
}
