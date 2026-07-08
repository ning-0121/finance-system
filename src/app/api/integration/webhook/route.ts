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
import type { WebhookPayload, SyncedOrder, PriceApprovalRequest, DelayApprovalRequest } from '@/lib/integration/types'
import { createServiceClient } from '@/lib/supabase/service'
import { poRequiresApproval } from '@/lib/integration/purchase-approval'

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

    case 'delay.requested':
      return handleDelayApprovalRequest(payload.data as unknown as DelayApprovalRequest)

    // 取消订单/里程碑 财务审批(接通:节拍器发起 → 财务审批队列 → 批/驳回传 approval_type:'cancel'/'milestone')
    case 'cancel.requested':
      return handleGenericApprovalRequest(payload.data as Record<string, unknown>, 'cancel')
    case 'milestone.requested':
      return handleGenericApprovalRequest(payload.data as Record<string, unknown>, 'milestone')

    case 'file.uploaded':
      return handleFileUpload(payload.data as Record<string, unknown>)

    case 'purchase_order.placed':
      return handlePurchaseOrderPlaced(payload.data as Record<string, unknown>, payload.request_id)

    // 采购单审批(≥¥5000):节拍器下单前发本事件卡住采购,财务侧本单进「待审批」。
    // 复用采购单落库逻辑,仅把 fin_status 置 pending_approval + requires_approval。
    case 'purchase_order.approval_requested':
      return handlePurchaseOrderPlaced(payload.data as Record<string, unknown>, payload.request_id, true)

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

    default:
      return { action: 'ignored', reason: `Unknown event type: ${payload.event}` }
  }
}

// --- 采购单下单入账（V1.0 头；V1.1 lines 行数据预留） ---
// requireApproval=true(来自 purchase_order.approval_requested)：≥¥5000 采购,本单进「待审批」。
async function handlePurchaseOrderPlaced(data: Record<string, unknown>, requestId: string, requireApproval = false) {
  const supabase = createServiceClient()
  const poKey = String(data.purchase_order_id || data.po_no || '')
  if (!poKey) throw new Error('purchase_order 缺少 purchase_order_id/po_no')

  const totalAmount = data.total_amount != null ? Number(data.total_amount) : null
  // 审批门槛复核(信任节拍器但自身也把关):要求审批且确达阈值 → 待审批
  const gated = requireApproval && poRequiresApproval(totalAmount)
  let headExtra: Record<string, unknown> = requireApproval && !gated ? { requires_approval: false } : {}
  if (gated) {
    // 审计 P1:若财务已对本单决策(approved/rejected),inbox 失败重投/内容变更重发不得把它
    // 打回 pending_approval(否则已批已下单的单凭空回到待审、留痕与状态自相矛盾)。仅未决策态才置待审批。
    const { data: existing } = await supabase.from('fin_purchase_orders')
      .select('fin_status').eq('purchase_order_id', poKey).maybeSingle()
    const decided = ['approved', 'rejected'].includes((existing as { fin_status?: string } | null)?.fin_status || '')
    headExtra = decided ? {} : { fin_status: 'pending_approval', requires_approval: true }
  }

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

  return { action: gated ? 'po_pending_approval' : 'po_registered', po_no: String(data.po_no || poKey), lines: lineCount }
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

  if (!budgetOrderId) return { action: 'ok', reason: `报价已存(synced_orders)，但该订单尚未建预算单(order=${orderNo})` }

  // 3. 只填 draft 预算，不覆盖已审批/已锁（报价存 synced_orders 待人工采纳）
  const { data: bo } = await supabase.from('budget_orders').select('status, total_revenue').eq('id', budgetOrderId).maybeSingle()
  if (bo && bo.status !== 'draft') return { action: 'ok', reason: `预算单非 draft(${bo?.status})，不自动覆盖，报价已存待人工采纳` }

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
  const r2 = (n: number) => Math.round(n * 100) / 100
  const fabric = r2(Number(bt.fabric_amount) || 0)
  const accessory = r2(Number(bt.accessory_amount) || 0)
  const processing = r2(Number(bt.cmt_amount) || 0)   // 加工费 → processing 桶
  if (fabric + accessory + processing <= 0) return { action: 'ignored', reason: 'order.budget_updated 预算为 0,跳过(等业务填了再推)' }

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
  if (!budgetOrderId) return { action: 'ok', reason: `预算已收到,但该订单尚未建预算单(order=${orderNo})——待建单后由下次保存补推` }

  // 2. 只填 draft 预算,不覆盖已审批/锁定(与 quotation.frozen 同一保守口径)
  const { data: bo } = await supabase.from('budget_orders').select('status, total_revenue, items').eq('id', budgetOrderId).maybeSingle()
  if (bo && bo.status !== 'draft') return { action: 'ok', reason: `预算单非 draft(${bo?.status}),不自动覆盖` }

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
  }
  // 保留已有 items 的收入行(如 SKU 款号行),只替换首行的 _cost_breakdown 载体
  const existingItems = Array.isArray((bo as { items?: unknown })?.items) ? ((bo as { items?: unknown[] }).items as unknown[]) : []
  const items = existingItems.length
    ? existingItems.map((it, i) => (i === 0 ? { ...(it as Record<string, unknown>), _cost_breakdown: cb } : it))
    : [{ _cost_breakdown: cb }]
  const { error } = await supabase.from('budget_orders').update({ items }).eq('id', budgetOrderId)
  if (error) throw new Error(`采购核料预算填充失败: ${error.message}`)
  return { action: 'done', reason: `采购核料预算已填 order=${orderNo || qimoOrderId} · 面料 ${fabric} / 加工 ${processing} / 辅料 ${accessory}` }
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

  // 2.6 已同步的采购单应付(审计P1):节拍器 order.deleted 带 po_nos(该订单关联的采购单号)。
  // fin_purchase_orders 不挂 budget_order_id,上面 budgetId 分支覆盖不到 → 订单删了采购应付成幽灵单。
  // 保守口径:存在则标记待人工红冲,绝不自动改账。
  try {
    const poNos = Array.isArray((order as unknown as { po_nos?: unknown[] }).po_nos)
      ? ((order as unknown as { po_nos?: unknown[] }).po_nos as unknown[]).map(String).map(s => s.trim()).filter(Boolean)
      : []
    if (poNos.length) {
      const { data: fpos } = await supabase.from('fin_purchase_orders')
        .select('po_no').in('po_no', poNos).is('deleted_at', null)
      if (fpos && fpos.length) {
        warnings.push(`存在 ${fpos.length} 张已同步采购单(${fpos.map(f => (f as { po_no?: string }).po_no).join('、')}),订单已${event === 'order.deleted' ? '删除' : '取消'},其采购应付需人工红冲——未自动改`)
      }
    }
  } catch { /* ignore */ }

  // 3. 撤未决审批（pending_approvals 无状态转换约束,可直接置 cancelled）
  try {
    const { data: cancelled } = await supabase.from('pending_approvals')
      .update({ status: 'cancelled' }).eq('order_no', order.order_no).eq('status', 'pending').select('id')
    if (cancelled && cancelled.length) actions.push(`撤销 ${cancelled.length} 条未决审批`)
  } catch (e) { warnings.push(`撤审批失败: ${e instanceof Error ? e.message : e}`) }

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

// --- 延期审批请求 ---
async function handleDelayApprovalRequest(req: DelayApprovalRequest) {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('pending_approvals')
    .upsert({
      id: req.id,
      approval_type: 'delay',
      order_no: req.order_no,
      customer_name: null,
      requested_by_name: req.requester_name,
      summary: `${req.milestone_name}: ${req.reason_type}`,
      detail: {
        milestone_name: req.milestone_name,
        reason_type: req.reason_type,
        reason_detail: req.reason_detail,
        reason_category: req.reason_category,
        proposed_new_date: req.proposed_new_date,
        current_due_date: req.current_due_date,
        requires_customer_approval: req.requires_customer_approval,
      },
      status: 'pending',
      source_created_at: req.created_at,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`Delay approval sync failed: ${error.message}`)
  return { action: 'approval_queued', type: 'delay', order_no: req.order_no }
}

// --- 取消订单 / 里程碑 财务审批请求(通用)---
// 节拍器发起,财务在审批队列批/驳 → 现有 approve 路由透传 approval_type 回传节拍器 finance-callback。
// 载荷通用字段:id(必) / order_no / customer_name / requester_name / summary / detail / created_at。
async function handleGenericApprovalRequest(data: Record<string, unknown>, type: 'cancel' | 'milestone') {
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
    summary: (data.summary as string) || (type === 'cancel' ? '取消订单待财务审批' : '里程碑待财务确认'),
    detail: (data.detail as Record<string, unknown>) ?? data,
    expires_at: (data.expires_at as string) ?? null,
    status: 'pending',
    source_created_at: (data.created_at as string) ?? null,
    synced_at: new Date().toISOString(),
  }, { onConflict: 'id' })
  if (error) throw new Error(`${type} approval sync failed: ${error.message}`)
  return { action: 'approval_queued', type, order_no: (data.order_no as string) ?? null }
}

// --- 文件上传同步 ---
async function handleFileUpload(data: Record<string, unknown>) {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('uploaded_documents')
    .upsert({
      id: data.id as string,
      file_name: (data.file_name as string) || 'unnamed',
      file_type: (data.file_type as string) || 'image',
      file_size: data.file_size as number || null,
      file_url: data.file_url as string || null,
      status: 'confirmed',
      extracted_fields: data.extracted_fields || {},
      matched_customer: (data.matched_customer as string) || null,
      created_at: (data.created_at as string) || new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`File sync failed: ${error.message}`)
  return { action: 'file_synced', file_name: data.file_name }
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
