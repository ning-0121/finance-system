'use client'

import { Badge } from '@/components/ui/badge'
import type { BudgetOrderStatus, SettlementOrderStatus } from '@/lib/types'

const budgetStatusMap: Record<BudgetOrderStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  draft: { label: '草稿', variant: 'outline' },
  pending_review: { label: '待审批', variant: 'secondary' },
  approved: { label: '已通过', variant: 'default' },
  rejected: { label: '已驳回', variant: 'destructive' },
  closed: { label: '已关闭', variant: 'outline' },
}

const settlementStatusMap: Record<SettlementOrderStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  draft: { label: '草稿', variant: 'outline' },
  confirmed: { label: '已确认', variant: 'default' },
  locked: { label: '已锁定', variant: 'secondary' },
}

export function BudgetStatusBadge({ status }: { status: BudgetOrderStatus }) {
  const config = budgetStatusMap[status]
  return <Badge variant={config.variant}>{config.label}</Badge>
}

export function SettlementStatusBadge({ status }: { status: SettlementOrderStatus }) {
  const config = settlementStatusMap[status]
  return <Badge variant={config.variant}>{config.label}</Badge>
}
