/**
 * 订单删/取消 → 财务侧保守冲销(唯一实现)
 *
 * ⚠️ 为什么单独成模块(2026-08-01):
 *   这段级联此前只写在 webhook 路由里,而订单状态有【两条】入库路径——
 *     ① webhook  order.cancelled / order.deleted
 *     ② 定时同步 /api/integration/sync(每 6 小时全量重刷 lifecycle_status)
 *   走 ② 的单子(节拍器没发 webhook、或 webhook 断链期)状态会被刷成「已取消」,
 *   但预算草稿/采购审批/未决审批全都留着不动 —— 生产实证 1022978(QM-20260731-001):
 *   全程只有 order.created 一条事件,镜像却是 cancelled,预算草稿 BO-202608-0001 一直存活,
 *   财务列表照常显示"已删除"的单。
 *   同一份数据两条写入路径、只改一条,是本系统反复发作的一类 bug,故收敛为单一实现。
 *
 * 保守口径(老板拍板):
 *   · 只作废【从未确认的草稿】(soft-delete)+ 撤未决审批 + 撤未决采购审批;
 *   · 已确认预算 / 应付 / 已批已付采购 / 已过账凭证 —— 一律不自动改,
 *     改为进【作废审批队列】由财务终审,或记 warning 待人工红冲;
 *   · 每步各自 try/catch:任一步失败不阻断其余、不抛出
 *     (避免单个 order.deleted 处理异常 500;warnings 随响应回给节拍器)。
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SyncedOrder } from './types'
import { preflightOrderVoid } from '@/lib/financial/order-void'

/** 节拍器侧「死单」状态集合——中英文两种写法都覆盖(历史数据混用) */
export const DEAD_LIFECYCLE = ['cancelled', 'deleted', '已取消', '已删除'] as const

export function isDeadLifecycle(s: unknown): boolean {
  return DEAD_LIFECYCLE.includes(String(s || '').trim() as typeof DEAD_LIFECYCLE[number])
}

export interface OrderReversalResult {
  action: 'order_reversed'
  event: string
  order_no: string
  actions: string[]
  warnings: string[]
}

/**
 * 执行订单冲销级联。
 * @param supabase service client(绕 RLS;调用方负责鉴权)
 * @param order    节拍器订单(至少需 id / order_no;po_nos 可选,用于匹配采购单)
 * @param event    'order.deleted' | 'order.cancelled' | 'sync.cancelled'(同步侧发现的死单)
 */
export async function reverseOrder(
  supabase: SupabaseClient,
  order: SyncedOrder,
  event: string,
): Promise<OrderReversalResult> {
  const now = new Date().toISOString()
  const warnings: string[] = []
  const actions: string[] = []
  // 文案用词:删除 vs 取消(同步侧传 sync.* 时按 lifecycle 判断)
  const isDelete = event === 'order.deleted' || String(order.lifecycle_status || '').includes('删除') || String(order.lifecycle_status || '') === 'deleted'
  const verb = isDelete ? '删除' : '取消'
  const via = event.startsWith('sync.') ? '定时同步' : '节拍器同步'

  // 1. 镜像状态
  try {
    await supabase.from('synced_orders').update({
      lifecycle_status: order.lifecycle_status || (isDelete ? 'deleted' : 'cancelled'),
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
            .update({ deleted_at: now, delete_reason: `订单${verb}自动冲销(${via})` })
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

    // 费用归集:预算单一作废,挂在它上面的 cost_items 就成了「孤儿」——
    //   订单没了,这些真实发生的供应商费用既进不了任何订单成本,也不会自己消失,
    //   在费用归集页之外没有任何地方会提醒。审计 2026-08-03 实证:6 张已作废预算单
    //   上挂着 21 行孤儿费用(净额 ¥738.2,含一笔 -2000 定金冲抵)。
    //   同样保守:不自动删、不自动改挂,只把金额和行数报出来等人工处理。
    try {
      const { data: costs } = await supabase.from('cost_items')
        .select('amount').eq('budget_order_id', budgetId).is('deleted_at', null)
      if (costs && costs.length) {
        const sum = Math.round(costs.reduce((s, c) => s + (Number((c as { amount?: unknown }).amount) || 0), 0) * 100) / 100
        warnings.push(`预算单作废后仍挂着 ${costs.length} 行费用归集(合计 ¥${sum}),需人工改挂到正确订单或确认核销——未自动改`)
      }
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
        .update({ deleted_at: now, approval_note: `订单${verb}自动撤销(${via})`, updated_at: now })
        .in('id', undecided.map(p => p.id))
      if (error) warnings.push(`采购单撤销失败,需人工: ${error.message}`)
      else actions.push(`撤销 ${undecided.length} 张未决采购审批(${undecided.map(p => p.po_no).join('、')})`)
    }
    if (decided.length) {
      warnings.push(`存在 ${decided.length} 张已批/已付采购单(${decided.map(p => p.po_no).join('、')}),订单已${verb},其采购应付需人工红冲——未自动改`)
    }
  } catch (e) { warnings.push(`采购单级联处理异常: ${e instanceof Error ? e.message : e}`) }

  // 3. 撤未决审批。⚠️ pending_approvals.status CHECK 不含 'cancelled'(会 23514 静默失败→审批撤不掉、积压堆积);
  //    合法终态用 'expired'(2026-07-09 实测)。留因可追溯。
  try {
    const { data: expired, error: exErr } = await supabase.from('pending_approvals')
      .update({ status: 'expired', decided_at: now, decider_name: '系统', decision_note: `订单${verb}自动撤销未决审批(${via})` })
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
            reason: `节拍器${verb}订单,含已审批数据,待财务终审`,
            severity: report.severity,
            blockers: report.items,
            status: 'pending',
            requested_by_name: event.startsWith('sync.') ? '定时同步' : '节拍器',
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
