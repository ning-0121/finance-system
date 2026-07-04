'use client'

// ============================================================
// 录入/审批费用时的「预算对照」面板：关联订单后，在旁边显示该订单的
// 预算成本分解 vs 已归集，并对"本次录入会把某类推过预算"实时红色提示。
// ============================================================

import { useMemo } from 'react'
import type { BudgetOrder } from '@/lib/types'
import { COST_BUCKETS, bucketOfCostType, budgetBucketsFromOrder, zeroBuckets } from '@/lib/cost-buckets'

interface CostLike {
  id: string
  budget_order_id: string | null
  cost_type: string
  amount: number
  currency: string
  exchange_rate: number
}

const money = (n: number) => Math.round(n).toLocaleString('zh-CN')
const cnyOf = (c: CostLike) => (Number(c.amount) || 0) * ((c.currency || 'CNY') === 'CNY' ? 1 : (Number(c.exchange_rate) || 1))

export function BudgetRefPanel({ order, costItems, editItemId, currentCostType, currentAmountCny }: {
  order: BudgetOrder | undefined
  costItems: CostLike[]
  editItemId: string | null
  currentCostType: string
  currentAmountCny: number
}) {
  const { buckets: budget, hasBreakdown } = useMemo(
    () => order ? budgetBucketsFromOrder(order.items) : { buckets: zeroBuckets(), hasBreakdown: false },
    [order])

  const actual = useMemo(() => {
    const b = zeroBuckets()
    if (!order) return b
    for (const c of costItems) {
      if (c.budget_order_id !== order.id) continue
      if (c.id === editItemId) continue          // 编辑时排除本条自身
      if (c.cost_type === 'tax_point') continue  // 票点不计成本
      b[bucketOfCostType(c.cost_type)] += cnyOf(c)
    }
    return b
  }, [order, costItems, editItemId])

  if (!order) return null

  const curBucket = bucketOfCostType(currentCostType)
  const budgetTotal = COST_BUCKETS.reduce((s, k) => s + budget[k], 0)
  const actualTotal = COST_BUCKETS.reduce((s, k) => s + actual[k], 0)
  const addAmt = Math.max(0, Number(currentAmountCny) || 0)
  const projectedTotal = actualTotal + addAmt
  // 本次录入是否把「当前类」或「订单总成本」推过预算
  const curOver = budget[curBucket] > 0 && actual[curBucket] + addAmt > budget[curBucket] + 0.005
  const totalOver = budgetTotal > 0 && projectedTotal > budgetTotal + 0.005

  return (
    <div className={`rounded-lg border p-3 text-xs space-y-2 ${curOver || totalOver ? 'bg-red-50 border-red-300' : 'bg-blue-50/40 border-blue-200'}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">📋 预算对照（本订单）</span>
        <span className="text-muted-foreground">
          预算总 ¥{money(budgetTotal)} · 已归集 ¥{money(actualTotal)}{addAmt > 0 && <> · 含本次 <b className={totalOver ? 'text-red-600' : ''}>¥{money(projectedTotal)}</b></>}
        </span>
      </div>
      {!hasBreakdown && <p className="text-amber-600">该订单预算未做分类分解（可在订单详情「成本构成」编辑补充），仅按总额对照。</p>}
      <div className="space-y-0.5">
        {COST_BUCKETS.map(b => {
          const bud = budget[b], act = actual[b]
          const isCur = b === curBucket
          const projected = act + (isCur ? addAmt : 0)
          if (bud <= 0 && act <= 0 && !isCur) return null
          const over = bud > 0 && projected > bud + 0.005
          const remain = bud - projected
          return (
            <div key={b} className={`flex items-center justify-between ${isCur ? 'font-medium' : 'text-muted-foreground'}`}>
              <span className="w-16">{b}{isCur && addAmt > 0 && <span className="text-primary ml-0.5">←本次</span>}</span>
              <span className="tabular-nums">
                预算 ¥{money(bud)} · 已 ¥{money(act)}{isCur && addAmt > 0 && <> +¥{money(addAmt)}</>}
                {bud > 0 && <span className={over ? 'text-red-600 font-semibold ml-1' : 'text-green-700 ml-1'}> · {over ? `超¥${money(-remain)}` : `剩¥${money(remain)}`}</span>}
              </span>
            </div>
          )
        })}
      </div>
      {curOver && <p className="text-red-600 font-medium">⚠ 本次录入会使「{curBucket}」超出预算 ¥{money(actual[curBucket] + addAmt - budget[curBucket])}，请核对。</p>}
      {!curOver && totalOver && <p className="text-red-600 font-medium">⚠ 本次录入会使订单总成本超出预算 ¥{money(projectedTotal - budgetTotal)}。</p>}
    </div>
  )
}
