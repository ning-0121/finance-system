// ============================================================
// 成本分类桶（单一口径）——预算总表 / 录入预算对照 / GL 成本结转共用。
// budget: _cost_breakdown 的键 → 桶；actual: cost_items.cost_type → 桶。
// tax_point(票点)不入桶(不计成本，留退税核算)。
// ============================================================
export const COST_BUCKETS = ['面料', '辅料', '加工费', '货代', '装柜', '物流/其他'] as const
export type CostBucket = typeof COST_BUCKETS[number]

/** cost_items.cost_type → 桶 */
export function bucketOfCostType(t: string): CostBucket {
  switch (t) {
    case 'fabric': case 'procurement': return '面料'
    case 'accessory': return '辅料'
    case 'processing': case 'commission': return '加工费'
    case 'freight': case 'forwarder': return '货代'
    case 'container': case 'customs': return '装柜'
    default: return '物流/其他'   // logistics / other / tax(不应到这) 等
  }
}

/** _cost_breakdown 键 → 桶 */
export const BREAKDOWN_KEY_TO_BUCKET: Record<string, CostBucket> = {
  fabric: '面料', accessory: '辅料', processing: '加工费',
  forwarder: '货代', container: '装柜', logistics: '物流/其他',
}

export function zeroBuckets(): Record<CostBucket, number> {
  return { '面料': 0, '辅料': 0, '加工费': 0, '货代': 0, '装柜': 0, '物流/其他': 0 }
}

/** 从订单 items[0]._cost_breakdown 提取各桶预算(CNY) */
export function budgetBucketsFromOrder(items: unknown): { buckets: Record<CostBucket, number>; hasBreakdown: boolean } {
  const cb = ((items as Record<string, unknown>[] | null)?.[0]?._cost_breakdown || null) as Record<string, unknown> | null
  const buckets = zeroBuckets()
  let hasBreakdown = false
  if (cb) {
    for (const [k, bucket] of Object.entries(BREAKDOWN_KEY_TO_BUCKET)) {
      const v = Number(cb[k]) || 0
      if (v > 0) { buckets[bucket] += v; hasBreakdown = true }
    }
    for (const e of (cb.extras as { name?: string; amount?: number }[] | undefined) || []) {
      const v = Number(e?.amount) || 0
      if (v > 0) { buckets['物流/其他'] += v; hasBreakdown = true }
    }
  }
  return { buckets, hasBreakdown }
}
