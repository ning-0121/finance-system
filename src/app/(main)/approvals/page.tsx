'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { CheckCircle, XCircle, AlertTriangle, Loader2, Clock, Eye } from 'lucide-react'
import { toast } from 'sonner'
import { getBudgetOrders, updateBudgetOrderStatus, createApprovalLog } from '@/lib/supabase/queries'
import { createClient } from '@/lib/supabase/client'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import { canApprove, canViewApprovalQueue, requiresExtraConfirmation } from '@/lib/auth/permissions'
import { BudgetStatusBadge } from '@/components/shared/StatusBadge'
import { IntegrationApprovals } from './IntegrationApprovals'
import Link from 'next/link'
import type { BudgetOrder, ApprovalLog } from '@/lib/types'

export default function ApprovalsPage() {
  const { user } = useCurrentUser()
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState<{ order: BudgetOrder; action: 'approve' | 'reject' } | null>(null)
  const [comment, setComment] = useState('')
  const [highValueConfirmed, setHighValueConfirmed] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [internalMap, setInternalMap] = useState<Record<string, string>>({})  // budget_order_id → 内部订单号

  useEffect(() => {
    async function load() {
      setLoading(true)
      const all = await getBudgetOrders()
      const pending = all.filter(o => o.status === 'pending_review')
      setOrders(pending)
      // 内部订单号:synced_orders.style_no(按 budget_order_id 关联),方便财务按内部号查
      if (pending.length) {
        const sb = createClient()
        const { data: so } = await sb.from('synced_orders')
          .select('budget_order_id, style_no').in('budget_order_id', pending.map(o => o.id))
        const m: Record<string, string> = {}
        for (const s of (so as { budget_order_id?: string; style_no?: string }[] | null) || []) {
          if (s.budget_order_id && s.style_no) m[s.budget_order_id] = s.style_no
        }
        setInternalMap(m)
      }
      setLoading(false)
    }
    load()
  }, [])

  // 内部订单号:优先 synced_orders.style_no,兜底从 notes 解析"内部单号: XXX"
  const internalNo = (o: BudgetOrder) =>
    internalMap[o.id] || String((o as { notes?: string }).notes || '').match(/内部单号[:：]\s*(\S+)/)?.[1] || '-'

  // 财务全角色可【查看】审批队列(否则财务员看不到订单/集成审批通知);预算单审批动作仍限财务总监。
  if (!user || !canViewApprovalQueue(user)) {
    return (
      <div className="flex flex-col h-full">
        <Header title="审批队列" subtitle="仅财务可访问" />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted-foreground">您没有查看审批队列的权限。</p>
        </div>
      </div>
    )
  }
  const canApproveBudget = canApprove(user)  // 预算单审批:财务(finance_staff)/总监/admin —— 老板 2026-07-08 取消总监专审

  const handleApproval = async (action: 'approve' | 'reject') => {
    if (!showDialog || !user) return
    const order = showDialog.order

    if (action === 'approve' && requiresExtraConfirmation(order) && !highValueConfirmed) {
      toast.error('请确认大额订单审核')
      return
    }

    setProcessing(true)
    const newStatus = action === 'approve' ? 'approved' : 'rejected'

    const { error: statusError } = await updateBudgetOrderStatus(order.id, newStatus, user.id)
    if (statusError) {
      toast.error(`操作失败: ${statusError}`)
      setProcessing(false)
      return
    }

    const log: ApprovalLog = {
      id: `al-${Date.now()}`,
      entity_type: 'budget_order',
      entity_id: order.id,
      action,
      from_status: 'pending_review',
      to_status: newStatus,
      operator_id: user.id,
      operator: user,
      comment: comment || null,
      created_at: new Date().toISOString(),
    }
    await createApprovalLog(log)

    // 审批通过 → GL 受控灰度：入队生成「确认收入」草稿凭证（非阻塞；
    // 失败进异常中心，不影响审批结果，可后续重试/复核过账）
    if (action === 'approve') {
      fetch('/api/gl/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessEvent: 'order_approved', sourceType: 'budget_order', sourceId: order.id }),
      }).catch(err => console.error('[GL] 确认收入入队失败:', err))
    }

    setOrders(prev => prev.filter(o => o.id !== order.id))
    setShowDialog(null)
    setComment('')
    setHighValueConfirmed(false)
    setProcessing(false)

    toast.success(action === 'approve' ? '已通过' : '已驳回', {
      description: `${order.order_no} — ${order.customer?.company || ''}`,
    })
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="审批队列" subtitle={`${user.name} · 待处理 ${orders.length} 笔`} />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-amber-600">{orders.length}</p>
              <p className="text-xs text-muted-foreground mt-1">待审批</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-red-600">
                {orders.filter(o => requiresExtraConfirmation(o)).length}
              </p>
              <p className="text-xs text-muted-foreground mt-1">大额订单(&gt;$50K)</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold">
                {/* 折人民币口径——此前 USD/CNY 原币直加还标 $(审计 P1 混币) */}
                ¥{Math.round(orders.reduce((s, o) => s + (Number(o.total_revenue) || 0) * (o.currency === 'CNY' ? 1 : (Number(o.exchange_rate) || 7)), 0)).toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground mt-1">总金额(折人民币)</p>
            </CardContent>
          </Card>
        </div>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">待审批预算单</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : orders.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">
                <CheckCircle className="h-12 w-12 mx-auto mb-3 text-green-300" />
                <p>没有待审批的订单</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>订单号</TableHead>
                    <TableHead>内部订单号</TableHead>
                    <TableHead>客户</TableHead>
                    <TableHead className="text-right">总收入</TableHead>
                    <TableHead className="text-right">预计利润</TableHead>
                    <TableHead className="text-right">毛利率</TableHead>
                    <TableHead>提交时间</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map(order => {
                    const isHighValue = requiresExtraConfirmation(order)
                    return (
                      <TableRow key={order.id} className={isHighValue ? 'bg-amber-50/50' : ''}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Link href={`/orders/${order.id}`} className="text-primary hover:underline font-medium">
                              {order.order_no}
                            </Link>
                            {isHighValue && (
                              <Badge variant="secondary" className="bg-amber-100 text-amber-700 text-[10px]">
                                <AlertTriangle className="h-3 w-3 mr-0.5" />大额
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{internalNo(order)}</TableCell>
                        <TableCell>{order.customer?.company || '-'}</TableCell>
                        <TableCell className="text-right font-medium">{order.currency} {order.total_revenue.toLocaleString()}</TableCell>
                        <TableCell className={`text-right font-semibold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {order.currency} {order.estimated_profit.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            order.estimated_margin < 0 ? 'bg-red-100 text-red-700' : order.estimated_margin < 15 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                          }`}>{order.estimated_margin}%</span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(order.created_at).toLocaleDateString('zh-CN')}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-center gap-1">
                            <Link href={`/orders/${order.id}`}>
                              <Button variant="ghost" size="sm"><Eye className="h-4 w-4" /></Button>
                            </Link>
                            {canApproveBudget ? (
                              <>
                                <Button size="sm" variant="default" onClick={() => { setShowDialog({ order, action: 'approve' }); setHighValueConfirmed(false) }}>
                                  <CheckCircle className="h-3.5 w-3.5 mr-1" />通过
                                </Button>
                                <Button size="sm" variant="destructive" onClick={() => setShowDialog({ order, action: 'reject' })}>
                                  <XCircle className="h-3.5 w-3.5 mr-1" />驳回
                                </Button>
                              </>
                            ) : <span className="text-xs text-muted-foreground">待总监审批</span>}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* 集成审批(来自节拍器):price/delay/cancel/milestone —— 此前无 UI 的死信队列(审计#8) */}
        <IntegrationApprovals userId={user.id} userName={user.name} />
      </div>

      {/* Approve/Reject Dialog */}
      {showDialog && (
        <Dialog open={true} onOpenChange={() => { setShowDialog(null); setComment(''); setHighValueConfirmed(false) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{showDialog.action === 'approve' ? '审批通过确认' : '驳回确认'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-muted-foreground">订单: </span><span className="font-medium">{showDialog.order.order_no}</span></div>
                <div><span className="text-muted-foreground">客户: </span><span className="font-medium">{showDialog.order.customer?.company}</span></div>
                <div><span className="text-muted-foreground">金额: </span><span className="font-medium">{showDialog.order.currency} {showDialog.order.total_revenue.toLocaleString()}</span></div>
                <div><span className="text-muted-foreground">毛利率: </span><span className={`font-medium ${showDialog.order.estimated_margin < 15 ? 'text-amber-600' : 'text-green-600'}`}>{showDialog.order.estimated_margin}%</span></div>
              </div>

              {showDialog.action === 'approve' && requiresExtraConfirmation(showDialog.order) && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200" role="alert">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-amber-800">大额订单提醒</p>
                    <p className="text-xs text-amber-700 mt-1">该订单金额超过 $50,000，请仔细审核后确认。</p>
                    <label className="flex items-center gap-2 mt-2 cursor-pointer">
                      <Checkbox checked={highValueConfirmed} onCheckedChange={(v) => setHighValueConfirmed(v === true)} />
                      <span className="text-xs text-amber-800">我已仔细审核该大额订单</span>
                    </label>
                  </div>
                </div>
              )}

              <Textarea
                placeholder={showDialog.action === 'approve' ? '审批意见（选填）' : '驳回原因（建议填写）'}
                value={comment}
                onChange={e => setComment(e.target.value)}
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowDialog(null); setComment('') }}>取消</Button>
              {showDialog.action === 'approve' ? (
                <Button onClick={() => handleApproval('approve')} disabled={processing || (requiresExtraConfirmation(showDialog.order) && !highValueConfirmed)}>
                  {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                  确认通过
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => handleApproval('reject')} disabled={processing}>
                  {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <XCircle className="h-4 w-4 mr-1" />}
                  确认驳回
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
