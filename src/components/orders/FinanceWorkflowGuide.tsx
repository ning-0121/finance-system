'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  CheckCircle, Circle, AlertTriangle, ArrowRight, ChevronDown, ChevronUp,
  FileText, DollarSign, Ship, CreditCard, Calculator, Package, ClipboardCheck, Wallet,
} from 'lucide-react'
import Link from 'next/link'
import type { BudgetOrder } from '@/lib/types'

interface StepConfig {
  key: string
  label: string
  description: string
  icon: typeof FileText
  checkComplete: (order: BudgetOrder, context: WorkflowContext) => boolean
  checkBlocked: (order: BudgetOrder, context: WorkflowContext) => string | null
  actionLabel: string | ((o: BudgetOrder) => string)
  actionHref?: string
  actionTab?: string
}

interface WorkflowContext {
  hasSubDocs: boolean
  hasInvoices: boolean
  hasShippingDocs: boolean
  hasSettlement: boolean
  hasPayables: boolean
  hasCostItems: boolean
  invoiceCount: number
  paidCount: number
}

const STEPS: StepConfig[] = [
  {
    key: 'confirm',
    label: '订单确认',
    description: '核实客户、数量、PO号，填入报价金额',
    icon: ClipboardCheck,
    checkComplete: (o) => o.total_revenue > 0,
    checkBlocked: () => null,
    actionLabel: '填入金额',
    actionTab: 'budget',
  },
  {
    key: 'budget',
    label: '预算编制',
    description: '填入原料、加工费、运费、佣金等预估成本',
    icon: Calculator,
    checkComplete: (o) => o.total_cost > 0,
    checkBlocked: (o) => o.total_revenue <= 0 ? '请先完成订单确认（填入金额）' : null,
    actionLabel: '编制预算',
    actionTab: 'budget',
  },
  {
    key: 'approval',
    label: '预算审批',
    description: 'Su审核预算，毛利率<15%需特别关注',
    icon: CheckCircle,
    checkComplete: (o) => o.status === 'approved' || o.status === 'closed',
    checkBlocked: (o) => o.total_cost <= 0 ? '请先完成预算编制' : null,
    actionLabel: ((o: BudgetOrder) => o.status === 'draft' ? '提交审批' : o.status === 'pending_review' ? '等待Su审批' : '已通过') as string | ((o: BudgetOrder) => string),
  },
  {
    key: 'cost_tracking',
    label: '费用录入',
    description: '面料/辅料/加工费到货后，录入实际金额，系统自动对比预算',
    icon: DollarSign,
    checkComplete: (_, ctx) => ctx.hasInvoices || ctx.hasCostItems,
    checkBlocked: (o) => o.status !== 'approved' && o.status !== 'closed' ? '请先完成预算审批' : null,
    actionLabel: '录入费用',
    actionHref: '/costs',
  },
  {
    key: 'shipping',
    label: '出货管理',
    description: '出货前财务检查，管理PI/CI/装箱单/报关单',
    icon: Ship,
    checkComplete: (_, ctx) => ctx.hasShippingDocs,
    checkBlocked: (o) => o.status !== 'approved' && o.status !== 'closed' ? '请先完成预算审批' : null,
    actionLabel: '管理出货',
  },
  {
    key: 'collection',
    label: '收款登记',
    description: '客户付款到账后，登记回款，更新应收状态',
    icon: CreditCard,
    checkComplete: () => false, // 需要从actual_invoices判断
    checkBlocked: () => null,
    actionLabel: '登记回款',
    actionHref: '/receivables',
  },
  {
    key: 'settlement',
    label: '订单决算',
    description: '系统自动汇总实际费用，处理剩余物料，生成决算单',
    icon: Package,
    checkComplete: (_, ctx) => ctx.hasSettlement,
    checkBlocked: (_, ctx) => !ctx.hasInvoices && !ctx.hasCostItems ? '请先录入实际费用' : null,
    actionLabel: '生成决算',
  },
  {
    key: 'payment',
    label: '付款执行',
    description: '决算确认后自动生成应付，Su审批后付款',
    icon: Wallet,
    checkComplete: (_, ctx) => ctx.hasPayables && ctx.paidCount > 0,
    checkBlocked: (_, ctx) => !ctx.hasSettlement ? '请先完成订单决算' : null,
    actionLabel: '付款管理',
    actionHref: '/payments',
  },
]

interface Props {
  order: BudgetOrder
  context: WorkflowContext
  onNavigate?: (tab: string) => void
}

export function FinanceWorkflowGuide({ order, context, onNavigate }: Props) {
  const [expanded, setExpanded] = useState(true)

  // 计算当前步骤
  let currentStepIdx = 0
  for (let i = 0; i < STEPS.length; i++) {
    if (STEPS[i].checkComplete(order, context)) {
      currentStepIdx = i + 1
    } else {
      break
    }
  }

  const completedCount = STEPS.filter(s => s.checkComplete(order, context)).length
  const progress = Math.round((completedCount / STEPS.length) * 100)

  return (
    <Card className="border-primary/20 bg-primary/[0.02]">
      <CardContent className="p-4">
        {/* 顶部：进度条 */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">财务流程引导</h3>
            <Badge variant="secondary" className="text-[10px]">{completedCount}/{STEPS.length} 步完成</Badge>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-muted-foreground">{progress}%</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setExpanded(!expanded)}>
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* 步骤列表 */}
        {expanded && (
          <div className="space-y-1">
            {STEPS.map((step, idx) => {
              const isComplete = step.checkComplete(order, context)
              const blocked = step.checkBlocked(order, context)
              const isCurrent = idx === currentStepIdx
              const isPast = idx < currentStepIdx
              const isFuture = idx > currentStepIdx && !isComplete

              const actionLabel = typeof step.actionLabel === 'function'
                ? (step.actionLabel as (o: BudgetOrder) => string)(order)
                : step.actionLabel

              return (
                <div
                  key={step.key}
                  className={`flex items-center gap-3 p-2.5 rounded-lg transition-colors ${
                    isCurrent ? 'bg-primary/5 border border-primary/20' :
                    isComplete ? 'bg-green-50/50' :
                    blocked ? 'opacity-40' : ''
                  }`}
                >
                  {/* 状态图标 */}
                  <div className="shrink-0">
                    {isComplete ? (
                      <CheckCircle className="h-5 w-5 text-green-600" />
                    ) : blocked ? (
                      <Circle className="h-5 w-5 text-muted-foreground/30" />
                    ) : isCurrent ? (
                      <div className="h-5 w-5 rounded-full border-2 border-primary flex items-center justify-center">
                        <div className="h-2 w-2 rounded-full bg-primary" />
                      </div>
                    ) : (
                      <Circle className="h-5 w-5 text-muted-foreground/50" />
                    )}
                  </div>

                  {/* 步骤图标 */}
                  <step.icon className={`h-4 w-4 shrink-0 ${isComplete ? 'text-green-600' : isCurrent ? 'text-primary' : 'text-muted-foreground/50'}`} />

                  {/* 内容 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-sm font-medium ${isComplete ? 'text-green-700' : isCurrent ? 'text-primary' : 'text-muted-foreground'}`}>
                        {step.label}
                      </span>
                      {isCurrent && <Badge className="bg-primary/10 text-primary text-[9px] border-0">当前步骤</Badge>}
                      {isComplete && <span className="text-[10px] text-green-600">✓</span>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{step.description}</p>
                    {blocked && <p className="text-[10px] text-amber-600 mt-0.5">⚠ {blocked}</p>}
                  </div>

                  {/* 操作按钮 */}
                  {isCurrent && !blocked && (
                    step.key === 'confirm' || step.key === 'budget' ? (
                      <Button size="sm" className="shrink-0 h-7 text-xs" onClick={() => {
                        // 滚动到预算单详情区域
                        document.querySelector('[data-slot="tabs-content"]')?.scrollIntoView({ behavior: 'smooth' })
                        if (onNavigate) onNavigate('budget')
                      }}>
                        {actionLabel} <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    ) : step.key === 'shipping' ? (
                      <Link href={`/orders/${order.id}/shipping`}>
                        <Button size="sm" className="shrink-0 h-7 text-xs">
                          管理出货 <ArrowRight className="h-3 w-3 ml-1" />
                        </Button>
                      </Link>
                    ) : step.key === 'settlement' ? (
                      <Link href={`/orders/${order.id}/settlement`}>
                        <Button size="sm" className="shrink-0 h-7 text-xs">
                          生成决算 <ArrowRight className="h-3 w-3 ml-1" />
                        </Button>
                      </Link>
                    ) : step.actionHref ? (
                      <Link href={step.actionHref}>
                        <Button size="sm" className="shrink-0 h-7 text-xs">
                          {actionLabel} <ArrowRight className="h-3 w-3 ml-1" />
                        </Button>
                      </Link>
                    ) : step.actionTab && onNavigate ? (
                      <Button size="sm" className="shrink-0 h-7 text-xs" onClick={() => onNavigate(step.actionTab!)}>
                        {actionLabel} <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="shrink-0 h-7 text-xs" disabled>
                        {actionLabel}
                      </Button>
                    )
                  )}

                  {/* 移除重复的shipping和settlement按钮，已在上方合并 */}
                  {false && step.key === 'shipping' && isCurrent && !blocked && (
                    <Link href={`/orders/${order.id}/shipping`}>
                      <Button size="sm" className="shrink-0 h-7 text-xs">
                        管理出货 <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    </Link>
                  )}

                  {false && step.key === 'settlement' && isCurrent && !blocked && (
                    <Link href={`/orders/${order.id}/settlement`}>
                      <Button size="sm" className="shrink-0 h-7 text-xs">
                        生成决算 <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
