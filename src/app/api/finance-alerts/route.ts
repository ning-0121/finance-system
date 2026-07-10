// GET /api/finance-alerts — 财务待处理/异常聚合(P0-2:通知铃真实数据源)
// 把 P0-1 记下的静默丢弃告警 + 待审批 + 新到订单未入账 + GL/诊断异常 汇总,
// 让财务在通知铃里一眼看到「哪些单没进来、为什么、有什么待办」。只读聚合,不写库。
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { createServiceClient } from '@/lib/supabase/service'

export type FinanceAlert = {
  id: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  message: string
  href: string
}

const DEAD = ['cancelled', 'deleted', 'completed', 'archived', '已取消', '已删除', '已完成', '已归档']

export async function GET() {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const db = createServiceClient()
  const alerts: FinanceAlert[] = []
  const since = new Date(Date.now() - 7 * 864e5).toISOString()

  try {
    // 1. 待审批(价格/取消/里程碑 + 采购单)
    const [{ count: apprCount }, { count: poApprCount }] = await Promise.all([
      db.from('pending_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      db.from('fin_purchase_orders').select('id', { count: 'exact', head: true }).eq('fin_status', 'pending_approval').is('deleted_at', null),
    ])
    const totalAppr = (apprCount || 0) + (poApprCount || 0)
    if (totalAppr > 0) {
      alerts.push({ id: 'pending-approvals', severity: 'warning', title: `${totalAppr} 项待财务审批`, message: '价格/取消/里程碑/采购单等,请及时批复(批准后绮陌方可推进)', href: '/approvals' })
    }

    // 2. 新到订单未建预算(业务上传但财务收不到 = 老问题的可见化)
    const { data: intake } = await db.from('synced_orders')
      .select('order_no, budget_sync_status, lifecycle_status').is('budget_order_id', null).limit(500)
    const alive = (intake || []).filter((o) => !DEAD.includes(String(o.lifecycle_status || '')))
    if (alive.length) {
      const unmatched = alive.filter((o) => o.budget_sync_status === 'customer_unmatched').length
      const extra = unmatched ? `,其中 ${unmatched} 张客户匹配失败` : ''
      alerts.push({ id: 'intake-orders', severity: 'warning', title: `${alive.length} 张新到订单未建预算`, message: `业务上传的订单已同步、但未进预算${extra}。到订单页「🆕 新到订单」核对建单`, href: '/orders' })
    }

    // 3. 集成告警(P0-1 的静默丢弃痕迹)——按事件类型聚合,避免刷屏
    const { data: warns } = await db.from('integration_logs')
      .select('id, event_type, payload_summary, created_at').eq('status', 'warning').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(50)
    const warnAgg = new Map<string, { count: number; latest: string }>()
    for (const w of warns || []) {
      const et = String(w.event_type || 'unknown')
      const cur = warnAgg.get(et)
      if (cur) cur.count++
      else warnAgg.set(et, { count: 1, latest: String(w.payload_summary || '') })
    }
    for (const [et, info] of warnAgg) {
      alerts.push({ id: `warn-${et}`, severity: 'warning', title: `集成告警 · ${et}${info.count > 1 ? ` ×${info.count}` : ''}`, message: info.latest || '数据未入账,请核对', href: '/control-center' })
    }

    // 4. 诊断/GL 异常(save_diagnostic_logs error)
    const { data: diags } = await db.from('save_diagnostic_logs')
      .select('id, action, error_detail, created_at').eq('status', 'error').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(10)
    for (const d of diags || []) {
      alerts.push({ id: `diag-${d.id}`, severity: 'critical', title: `数据/GL 异常 · ${d.action || ''}`, message: String(d.error_detail || '').slice(0, 200), href: '/control-center' })
    }
  } catch (e) {
    // 聚合失败也不让铃铛崩:返回已收集到的部分 + 一条自诊断
    alerts.push({ id: 'alerts-error', severity: 'info', title: '通知加载部分失败', message: e instanceof Error ? e.message : '未知错误', href: '/control-center' })
  }

  // 严重优先排序
  const rank = { critical: 0, warning: 1, info: 2 }
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity])
  return NextResponse.json({ alerts, count: alerts.length })
}
