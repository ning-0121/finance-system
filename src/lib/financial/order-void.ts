// ============================================================
// 订单作废「体检」——只读扫描一张预算单牵连的所有子数据,分三级:
//   🟢 green  可直接撤(未决、没动钱)
//   🟡 amber  已审批·需财务确认(批过但没动钱)
//   🔴 red    硬阻断·联系管理员(真金白银已动:已付款/已收款核销/已下采购放行)
// 切片1(只读弹窗)、切片3(级联软删前复检)、切片4(webhook 兜底)共用同一分级口径。
// 纯读、零写 —— 符合「AI/自动化只读,写库须财务审批」铁律。
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeOrderRefs } from '@/lib/integration/order-refs'

export type VoidLevel = 'green' | 'amber' | 'red'

export interface VoidItem {
  table: string
  label: string        // 中文分类名
  level: VoidLevel
  count: number
  detail: string       // 一句话说明(含金额/状态)
  ids: string[]        // 命中行 id(供切片3 级联软删)
}

export interface VoidPreflight {
  budgetOrderId: string
  orderNo: string | null
  internalNo: string | null
  qmOrderNo: string | null
  items: VoidItem[]
  severity: 'clean' | 'has_approved' | 'blocked_admin'
  hasApproved: boolean   // 含 🟡
  hasBlocker: boolean    // 含 🔴
}

const money = (n: number) => `¥${Math.round(n).toLocaleString()}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, any, any>

export async function preflightOrderVoid(sb: SB, budgetOrderId: string): Promise<VoidPreflight> {
  const items: VoidItem[] = []
  const add = (i: VoidItem) => { if (i.count > 0) items.push(i) }

  // 0. 订单主体本身
  const { data: bo } = await sb.from('budget_orders')
    .select('id, order_no, status').eq('id', budgetOrderId).maybeSingle()
  const boStatus = String(bo?.status || '')
  const orderApproved = boStatus === 'approved' || boStatus === 'closed'
  add({
    table: 'budget_orders', label: '预算单', level: orderApproved ? 'amber' : 'green', count: 1,
    detail: orderApproved ? `预算单已审批(${boStatus})—作废需财务确认` : `预算单未审批(${boStatus})—可直接撤`,
    ids: [budgetOrderId],
  })

  // 关联的 synced_orders(取 QM号/款号 + 供采购单 order_refs 匹配)
  const { data: so } = await sb.from('synced_orders')
    .select('id, order_no, style_no').eq('budget_order_id', budgetOrderId)
  const syncedRows = (so as { id: string; order_no: string | null; style_no: string | null }[] | null) || []
  const syncedIds = new Set(syncedRows.map(s => s.id))
  const syncedNos = new Set(syncedRows.map(s => s.order_no).filter(Boolean) as string[])

  // 1. 实际发票 actual_invoices:pending→🟢 approved/disputed→🟡 paid→🔴
  const { data: inv } = await sb.from('actual_invoices')
    .select('id, status, invoice_amount, currency').eq('budget_order_id', budgetOrderId).is('deleted_at', null)
  const invRows = (inv as { id: string; status: string; invoice_amount: number | null }[] | null) || []
  const invBy = (pred: (s: string) => boolean) => invRows.filter(r => pred(r.status))
  const invSum = (rs: typeof invRows) => rs.reduce((s, r) => s + (Number(r.invoice_amount) || 0), 0)
  add({ table: 'actual_invoices', label: '实际发票·待处理', level: 'green', count: invBy(s => s === 'pending').length, detail: `${invBy(s => s === 'pending').length} 张待处理发票`, ids: invBy(s => s === 'pending').map(r => r.id) })
  const invAmber = invBy(s => s === 'approved' || s === 'disputed')
  add({ table: 'actual_invoices', label: '实际发票·已批准', level: 'amber', count: invAmber.length, detail: `${invAmber.length} 张已批准/争议发票 ${money(invSum(invAmber))}—需财务确认`, ids: invAmber.map(r => r.id) })
  const invPaid = invBy(s => s === 'paid')
  add({ table: 'actual_invoices', label: '实际发票·已付款', level: 'red', count: invPaid.length, detail: `${invPaid.length} 张已付款发票 ${money(invSum(invPaid))}—已动钱,须先红冲`, ids: invPaid.map(r => r.id) })

  // 2. 应付 payable_records:unpaid→🟢 approved/pending_approval→🟡 paid→🔴
  const { data: pay } = await sb.from('payable_records')
    .select('id, payment_status, paid_at, amount, currency').eq('budget_order_id', budgetOrderId).is('deleted_at', null)
  const payRows = (pay as { id: string; payment_status: string; paid_at: string | null; amount: number | null }[] | null) || []
  const paySum = (rs: typeof payRows) => rs.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const payGreen = payRows.filter(r => r.payment_status === 'unpaid')
  const payAmber = payRows.filter(r => (r.payment_status === 'approved' || r.payment_status === 'pending_approval') && !r.paid_at)
  const payRed = payRows.filter(r => r.payment_status === 'paid' || !!r.paid_at)
  add({ table: 'payable_records', label: '应付·未付', level: 'green', count: payGreen.length, detail: `${payGreen.length} 笔未付应付—可直接撤`, ids: payGreen.map(r => r.id) })
  add({ table: 'payable_records', label: '应付·已批准未付', level: 'amber', count: payAmber.length, detail: `${payAmber.length} 笔已批准应付 ${money(paySum(payAmber))}—需财务确认`, ids: payAmber.map(r => r.id) })
  add({ table: 'payable_records', label: '应付·已付款', level: 'red', count: payRed.length, detail: `${payRed.length} 笔已付款 ${money(paySum(payRed))}—已动钱,须先红冲`, ids: payRed.map(r => r.id) })

  // 3. 决算 order_settlements:draft→🟢 confirmed/locked→🟡
  const { data: st } = await sb.from('order_settlements')
    .select('id, status').eq('budget_order_id', budgetOrderId).is('deleted_at', null)
  const stRows = (st as { id: string; status: string }[] | null) || []
  const stGreen = stRows.filter(r => r.status === 'draft')
  const stAmber = stRows.filter(r => r.status === 'confirmed' || r.status === 'locked')
  add({ table: 'order_settlements', label: '决算单·草稿', level: 'green', count: stGreen.length, detail: `${stGreen.length} 张草稿决算—可直接撤`, ids: stGreen.map(r => r.id) })
  add({ table: 'order_settlements', label: '决算单·已确认/锁定', level: 'amber', count: stAmber.length, detail: `${stAmber.length} 张已确认/锁定决算—需财务确认`, ids: stAmber.map(r => r.id) })

  // 4. 费用归集 cost_items → 🟢(仅成本记录,随单撤)
  const { data: ci } = await sb.from('cost_items')
    .select('id').eq('budget_order_id', budgetOrderId).is('deleted_at', null)
  const ciRows = (ci as { id: string }[] | null) || []
  add({ table: 'cost_items', label: '费用归集', level: 'green', count: ciRows.length, detail: `${ciRows.length} 条归集成本—随单撤`, ids: ciRows.map(r => r.id) })

  // 5. 出货单 shipping_documents:draft→🟢 submitted/completed→🟡
  const { data: sh } = await sb.from('shipping_documents')
    .select('id, status').eq('budget_order_id', budgetOrderId).is('deleted_at', null)
  const shRows = (sh as { id: string; status: string }[] | null) || []
  const shGreen = shRows.filter(r => r.status === 'draft')
  const shAmber = shRows.filter(r => r.status !== 'draft')
  add({ table: 'shipping_documents', label: '出货单·草稿', level: 'green', count: shGreen.length, detail: `${shGreen.length} 张草稿出货单`, ids: shGreen.map(r => r.id) })
  add({ table: 'shipping_documents', label: '出货单·已提交/完成', level: 'amber', count: shAmber.length, detail: `${shAmber.length} 张已提交/完成出货单—需财务确认`, ids: shAmber.map(r => r.id) })

  // 6. 回款核销 receivable_payment_allocations(未作废)→ 🔴 已收款
  const { data: alloc } = await sb.from('receivable_payment_allocations')
    .select('id, allocated_amount').eq('budget_order_id', budgetOrderId).is('voided_at', null)
  const allocRows = (alloc as { id: string; allocated_amount: number | null }[] | null) || []
  add({ table: 'receivable_payment_allocations', label: '回款核销', level: 'red', count: allocRows.length, detail: `${allocRows.length} 笔已收款核销 ${money(allocRows.reduce((s, r) => s + (Number(r.allocated_amount) || 0), 0))}—已收钱,须先红冲/撤销`, ids: allocRows.map(r => r.id) })

  // 7. 采购单 fin_purchase_orders(靠 order_refs 匹配 synced_orders):
  //    pending/pending_approval→🟢(撤审批) approved→🔴(已下采购放行,联系管理员) rejected/ignored→忽略
  if (syncedIds.size || syncedNos.size) {
    const { data: pos } = await sb.from('fin_purchase_orders')
      .select('id, po_no, fin_status, order_refs').is('deleted_at', null)
    const posRows = (pos as { id: string; po_no: string; fin_status: string; order_refs: unknown }[] | null) || []
    const mine = posRows.filter(p => {
      const refs = normalizeOrderRefs(p.order_refs)
      return refs.some(r => syncedIds.has(r.id) || (r.order_no && syncedNos.has(r.order_no)))
    })
    const poGreen = mine.filter(p => p.fin_status === 'pending' || p.fin_status === 'pending_approval')
    const poRed = mine.filter(p => p.fin_status === 'approved')
    add({ table: 'fin_purchase_orders', label: '采购单·待审/未决', level: 'green', count: poGreen.length, detail: `${poGreen.length} 张未决采购单—撤出审批队列`, ids: poGreen.map(p => p.id) })
    add({ table: 'fin_purchase_orders', label: '采购单·已批准(已下采购)', level: 'red', count: poRed.length, detail: `${poRed.length} 张已批准采购单已放行供应商—须联系管理员`, ids: poRed.map(p => p.id) })
  }

  // 8. 集成审批 pending_approvals(该单未决)→ 🟢(随撤置 expired)
  if (syncedNos.size) {
    const { data: pa } = await sb.from('pending_approvals')
      .select('id, approval_type').eq('status', 'pending').in('order_no', [...syncedNos])
    const paRows = (pa as { id: string; approval_type: string }[] | null) || []
    add({ table: 'pending_approvals', label: '集成审批·未决', level: 'green', count: paRows.length, detail: `${paRows.length} 条未决集成审批—随单撤销`, ids: paRows.map(r => r.id) })
  }

  const hasBlocker = items.some(i => i.level === 'red')
  const hasApproved = items.some(i => i.level === 'amber')
  return {
    budgetOrderId,
    orderNo: (bo?.order_no as string) || null,
    internalNo: syncedRows.map(s => s.style_no).find(Boolean) || null,
    qmOrderNo: syncedRows.map(s => s.order_no).find(Boolean) || null,
    items,
    severity: hasBlocker ? 'blocked_admin' : hasApproved ? 'has_approved' : 'clean',
    hasApproved,
    hasBlocker,
  }
}

// ============================================================
// 级联软删(切片3)· 财务终审通过后调用
// 忠实复刻 softDeleteFinancialEntity 的契约(deleted_at/by/reason + save_diagnostic_logs),
// 但走 service client、服务端执行,actor=真实终审人。全部软删/作废,可逆(见 restoreVoidedOrder)。
// GL 凭证(journal_*)不在体检范围 → 级联不碰(冲销需红冲,不静默删)。
// ============================================================
const FIN_CASCADE_TABLES = ['actual_invoices', 'payable_records', 'order_settlements', 'cost_items', 'shipping_documents'] as const

export interface CascadeResult {
  marker: string
  financial: Record<string, string[]>       // 各财务表软删的 id(按 delete_reason marker 可恢复)
  finPoIds: string[]                         // 采购单软删 id(仅 deleted_at,按 id 恢复)
  allocIds: string[]                         // 回款核销作废 id(voided_at,按 id 恢复)
  pendingIds: string[]                       // 集成审批置 expired 的 id
  synced: { id: string; prev: string | null }[]  // synced_orders 生命周期(存原值供恢复)
  budgetPrevStatus: string | null
  errors: string[]
}

const idsOf = (report: VoidPreflight, table: string) =>
  [...new Set(report.items.filter(i => i.table === table).flatMap(i => i.ids))]

async function audit(sb: SB, table: string, recordId: string, actorId: string, detail: string) {
  try {
    await sb.from('save_diagnostic_logs').insert({
      action: 'soft_delete', table_name: table, record_id: recordId, actor_id: actorId,
      source_page: 'order-void', status: 'ok', error_detail: null, payload_hash: null, db_hash: null,
    })
  } catch (e) { console.error('[order-void] audit 写入失败:', e) }
}

export async function cascadeVoidOrder(
  sb: SB, report: VoidPreflight, opts: { actorId: string; reason: string; requestId: string; allowBlocked: boolean },
): Promise<CascadeResult> {
  const { actorId, reason, requestId, allowBlocked } = opts
  const marker = `作废#${requestId}`
  const delReason = `${marker}: ${reason}`.slice(0, 500)
  const res: CascadeResult = { marker, financial: {}, finPoIds: [], allocIds: [], pendingIds: [], synced: [], budgetPrevStatus: null, errors: [] }
  const budgetOrderId = report.budgetOrderId

  // 1. 财务子表(白名单):deleted_at/by/reason
  for (const t of FIN_CASCADE_TABLES) {
    const ids = idsOf(report, t)
    if (!ids.length) continue
    const { error } = await sb.from(t).update({ deleted_at: new Date().toISOString(), deleted_by: actorId, delete_reason: delReason })
      .in('id', ids).is('deleted_at', null)
    if (error) { res.errors.push(`${t}: ${error.message}`); continue }
    res.financial[t] = ids
    await audit(sb, t, ids[0], actorId, `级联作废 ${ids.length} 行`)
  }

  // 2. 采购单 fin_purchase_orders(仅 deleted_at)。已批准(🔴)仅在 allowBlocked 时撤。
  const poIds = idsOf(report, 'fin_purchase_orders')
  if (poIds.length) {
    // 未决(green)总是撤;已批准(red)需 allowBlocked
    const redPo = new Set(report.items.filter(i => i.table === 'fin_purchase_orders' && i.level === 'red').flatMap(i => i.ids))
    const toVoid = allowBlocked ? poIds : poIds.filter(id => !redPo.has(id))
    if (toVoid.length) {
      const { error } = await sb.from('fin_purchase_orders').update({ deleted_at: new Date().toISOString() }).in('id', toVoid).is('deleted_at', null)
      if (error) res.errors.push(`fin_purchase_orders: ${error.message}`); else res.finPoIds = toVoid
    }
  }

  // 3. 回款核销 allocations(🔴):仅 allowBlocked 时作废
  if (allowBlocked) {
    const allocIds = idsOf(report, 'receivable_payment_allocations')
    if (allocIds.length) {
      const { error } = await sb.from('receivable_payment_allocations').update({ voided_at: new Date().toISOString(), voided_by: actorId, void_reason: delReason }).in('id', allocIds).is('voided_at', null)
      if (error) res.errors.push(`allocations: ${error.message}`); else res.allocIds = allocIds
    }
  }

  // 4. 集成审批 pending_approvals → expired
  const paIds = idsOf(report, 'pending_approvals')
  if (paIds.length) {
    const { error } = await sb.from('pending_approvals').update({ status: 'expired', decided_at: new Date().toISOString(), decision_note: `${marker} 订单作废,自动撤销` }).in('id', paIds).eq('status', 'pending')
    if (error) res.errors.push(`pending_approvals: ${error.message}`); else res.pendingIds = paIds
  }

  // 5. synced_orders 生命周期 → cancelled(存原值供恢复)
  const { data: sos } = await sb.from('synced_orders').select('id, lifecycle_status').eq('budget_order_id', budgetOrderId)
  for (const s of (sos as { id: string; lifecycle_status: string | null }[] | null) || []) {
    const { error } = await sb.from('synced_orders').update({ lifecycle_status: 'cancelled' }).eq('id', s.id)
    if (error) res.errors.push(`synced_orders(${s.id}): ${error.message}`); else res.synced.push({ id: s.id, prev: s.lifecycle_status })
  }

  // 6. 订单主体 budget_orders(最后):存原 status,软删
  const { data: boCur } = await sb.from('budget_orders').select('status').eq('id', budgetOrderId).maybeSingle()
  res.budgetPrevStatus = (boCur?.status as string) || null
  const { error: boErr } = await sb.from('budget_orders').update({ deleted_at: new Date().toISOString(), deleted_by: actorId, delete_reason: delReason }).eq('id', budgetOrderId).is('deleted_at', null)
  if (boErr) res.errors.push(`budget_orders: ${boErr.message}`); else { res.financial['budget_orders'] = [budgetOrderId]; await audit(sb, 'budget_orders', budgetOrderId, actorId, '订单作废') }

  return res
}

// 恢复(切片3)· 管理员撤销一次作废,按 cascade_result 精确回滚
export async function restoreVoidedOrder(sb: SB, cascade: CascadeResult): Promise<{ errors: string[] }> {
  const errors: string[] = []
  const clearFin = { deleted_at: null, deleted_by: null, delete_reason: null }
  for (const [t, ids] of Object.entries(cascade.financial || {})) {
    if (!ids?.length) continue
    const { error } = await sb.from(t).update(clearFin).in('id', ids)
    if (error) errors.push(`${t}: ${error.message}`)
  }
  if (cascade.finPoIds?.length) {
    const { error } = await sb.from('fin_purchase_orders').update({ deleted_at: null }).in('id', cascade.finPoIds)
    if (error) errors.push(`fin_purchase_orders: ${error.message}`)
  }
  if (cascade.allocIds?.length) {
    const { error } = await sb.from('receivable_payment_allocations').update({ voided_at: null, voided_by: null, void_reason: null }).in('id', cascade.allocIds)
    if (error) errors.push(`allocations: ${error.message}`)
  }
  if (cascade.pendingIds?.length) {
    const { error } = await sb.from('pending_approvals').update({ status: 'pending', decided_at: null, decision_note: null }).in('id', cascade.pendingIds)
    if (error) errors.push(`pending_approvals: ${error.message}`)
  }
  for (const s of cascade.synced || []) {
    const { error } = await sb.from('synced_orders').update({ lifecycle_status: s.prev }).eq('id', s.id)
    if (error) errors.push(`synced_orders(${s.id}): ${error.message}`)
  }
  return { errors }
}
