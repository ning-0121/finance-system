// ============================================================
// Profit Recommendation Engine
// Generates actionable suggestions ordered by impact priority:
// 1st: Control CMT  2nd: Fabric price  3rd: Trims/packing
// 4th: Freight      Last: Ask customer for higher price
// ============================================================

import { classifyMarginRisk } from './profit-calculator'

export type RecommendationType =
  | 'reduce_cmt'
  | 'reduce_fabric_price'
  | 'reduce_fabric_usage'
  | 'reduce_trim_cost'
  | 'reduce_packing_cost'
  | 'adjust_freight'
  | 'exchange_rate_risk'
  | 'low_margin_warning'
  | 'customer_margin_warning'
  | 'healthy'

export type RecommendationSeverity = 'critical' | 'warning' | 'info' | 'success'

export interface Recommendation {
  type: RecommendationType
  severity: RecommendationSeverity
  title: string
  message: string
  suggestedAction: string
  expectedMarginImprovement?: number   // percentage points
  priority: number                      // 1 = highest priority
}

// ─────────────────────────────────────────────────────────────
// Benchmark interface (mirrors DB table)
// ─────────────────────────────────────────────────────────────

export interface CostBenchmark {
  product_category: string
  size_type: string
  target_fabric_usage_kg?: number
  target_fabric_price_per_kg_rmb?: number
  target_cmt_cost_rmb?: number
  target_trim_cost_rmb?: number
  target_packing_cost_rmb?: number
  target_margin?: number
}

// ─────────────────────────────────────────────────────────────
// Style-level recommendation
// ─────────────────────────────────────────────────────────────

export interface StyleAnalysisInput {
  style_no: string
  product_category: string | null
  size_type: string
  selling_price_per_piece_usd: number
  fabric_usage_kg_per_piece: number
  fabric_price_per_kg_rmb: number
  cmt_cost_per_piece_rmb: number
  trim_cost_per_piece_rmb: number
  packing_cost_per_piece_rmb: number
  freight_cost_per_piece_usd: number
  other_cost_per_piece_rmb: number
  exchange_rate: number
  margin_per_style: number    // already computed
  total_cost_per_piece_usd: number
  benchmark?: CostBenchmark
}

export function generateStyleRecommendations(input: StyleAnalysisInput): Recommendation[] {
  const recs: Recommendation[] = []
  const risk = classifyMarginRisk(input.margin_per_style)
  const b = input.benchmark
  const rmbToUsd = (rmb: number) => rmb / (input.exchange_rate || 7)

  // ── Margin risk flag ──────────────────────────────────────
  if (risk === 'critical') {
    recs.push({
      type: 'low_margin_warning',
      severity: 'critical',
      title: `款式 ${input.style_no} 毛利率严重偏低`,
      message: `当前毛利率 ${input.margin_per_style.toFixed(1)}%，低于安全线 10%。单件成本 $${input.total_cost_per_piece_usd.toFixed(2)}，售价 $${input.selling_price_per_piece_usd.toFixed(2)}。`,
      suggestedAction: '请优先削减加工费，其次谈面料价格。如各成本已压至极限，再考虑调整售价。',
      priority: 0,
    })
  } else if (risk === 'warning') {
    recs.push({
      type: 'low_margin_warning',
      severity: 'warning',
      title: `款式 ${input.style_no} 毛利率偏低`,
      message: `当前毛利率 ${input.margin_per_style.toFixed(1)}%，建议目标 ≥ 15%。还差约 ${(15 - input.margin_per_style).toFixed(1)} 个百分点。`,
      suggestedAction: '可先从加工费和面料价格入手，对成本结构进行优化。',
      priority: 1,
    })
  }

  // ── Priority 1: CMT cost ──────────────────────────────────
  if (b?.target_cmt_cost_rmb && input.cmt_cost_per_piece_rmb > b.target_cmt_cost_rmb * 1.05) {
    const excess = input.cmt_cost_per_piece_rmb - b.target_cmt_cost_rmb
    const savingUsd = rmbToUsd(excess)
    const marginGain = input.selling_price_per_piece_usd > 0
      ? (savingUsd / input.selling_price_per_piece_usd) * 100
      : 0
    recs.push({
      type: 'reduce_cmt',
      severity: 'warning',
      title: '加工费 (CMT) 高于行业基准',
      message: `当前加工费 ¥${input.cmt_cost_per_piece_rmb}/件，基准 ¥${b.target_cmt_cost_rmb}/件，高出 ¥${excess.toFixed(2)}/件 (${((excess / b.target_cmt_cost_rmb) * 100).toFixed(1)}%)。`,
      suggestedAction: `建议与工厂重新谈价至 ¥${b.target_cmt_cost_rmb}/件。预计毛利率提升约 ${marginGain.toFixed(1)} 个百分点。`,
      expectedMarginImprovement: Math.round(marginGain * 10) / 10,
      priority: 1,
    })
  }

  // ── Priority 2a: Fabric price ─────────────────────────────
  if (b?.target_fabric_price_per_kg_rmb && input.fabric_price_per_kg_rmb > b.target_fabric_price_per_kg_rmb * 1.08) {
    const overprice = input.fabric_price_per_kg_rmb - b.target_fabric_price_per_kg_rmb
    const fabricSaving = overprice * input.fabric_usage_kg_per_piece
    const savingUsd = rmbToUsd(fabricSaving)
    const marginGain = input.selling_price_per_piece_usd > 0
      ? (savingUsd / input.selling_price_per_piece_usd) * 100
      : 0
    recs.push({
      type: 'reduce_fabric_price',
      severity: 'warning',
      title: '面料价格高于基准 8% 以上',
      message: `面料单价 ¥${input.fabric_price_per_kg_rmb}/kg，基准 ¥${b.target_fabric_price_per_kg_rmb}/kg，高出 ¥${overprice.toFixed(2)}/kg。按 ${input.fabric_usage_kg_per_piece}kg/件 计算，每件多成本 ¥${fabricSaving.toFixed(2)}。`,
      suggestedAction: `建议与面料供应商谈价至 ¥${b.target_fabric_price_per_kg_rmb}/kg 以内。可考虑批量采购或换替代面料。预计提升毛利率约 ${marginGain.toFixed(1)} 个百分点。`,
      expectedMarginImprovement: Math.round(marginGain * 10) / 10,
      priority: 2,
    })
  }

  // ── Priority 2b: Fabric usage ─────────────────────────────
  if (b?.target_fabric_usage_kg && input.fabric_usage_kg_per_piece > b.target_fabric_usage_kg * 1.10) {
    const overUsage = input.fabric_usage_kg_per_piece - b.target_fabric_usage_kg
    recs.push({
      type: 'reduce_fabric_usage',
      severity: 'info',
      title: '面料用量高于基准',
      message: `当前面料用量 ${input.fabric_usage_kg_per_piece}kg/件，基准 ${b.target_fabric_usage_kg}kg/件，高出 ${(overUsage * 1000).toFixed(0)}g/件。`,
      suggestedAction: '可与版师沟通优化版型、减少面料损耗，或选用幅宽更宽的面料提升利用率。',
      priority: 2,
    })
  }

  // ── Priority 3: Trims ─────────────────────────────────────
  if (b?.target_trim_cost_rmb && input.trim_cost_per_piece_rmb > b.target_trim_cost_rmb * 1.15) {
    const excess = input.trim_cost_per_piece_rmb - b.target_trim_cost_rmb
    recs.push({
      type: 'reduce_trim_cost',
      severity: 'info',
      title: '辅料成本偏高',
      message: `辅料费 ¥${input.trim_cost_per_piece_rmb}/件，基准 ¥${b.target_trim_cost_rmb}/件，高出 ¥${excess.toFixed(2)}/件。`,
      suggestedAction: '建议审查 hangtag、joker tag、吊粒、拉链、松紧带、标签、polybag 等辅料用量及采购单价。',
      priority: 3,
    })
  }

  // ── Priority 3: Packing ───────────────────────────────────
  if (b?.target_packing_cost_rmb && input.packing_cost_per_piece_rmb > b.target_packing_cost_rmb * 1.20) {
    const excess = input.packing_cost_per_piece_rmb - b.target_packing_cost_rmb
    recs.push({
      type: 'reduce_packing_cost',
      severity: 'info',
      title: '包装成本高于基准',
      message: `包装费 ¥${input.packing_cost_per_piece_rmb}/件，基准 ¥${b.target_packing_cost_rmb}/件，高出 ¥${excess.toFixed(2)}/件。`,
      suggestedAction: '可考虑优化包装规格，减少多余内衬或改用经济型包材。',
      priority: 3,
    })
  }

  // ── Priority 4: Freight ───────────────────────────────────
  if (input.freight_cost_per_piece_usd > 0 && input.selling_price_per_piece_usd > 0) {
    const freightRatio = (input.freight_cost_per_piece_usd / input.selling_price_per_piece_usd) * 100
    if (freightRatio > 8) {
      recs.push({
        type: 'adjust_freight',
        severity: 'info',
        title: '物流成本占比偏高',
        message: `物流费 $${input.freight_cost_per_piece_usd}/件，占售价 ${freightRatio.toFixed(1)}%。行业参考值通常 5% 以内。`,
        suggestedAction: '可考虑提高单箱装箱数量、合并装柜、优化运输方式（FCL vs LCL vs 空运）。',
        priority: 4,
      })
    }
  }

  // ── Healthy ───────────────────────────────────────────────
  if (recs.length === 0 || risk === 'healthy') {
    if (risk === 'healthy') {
      recs.push({
        type: 'healthy',
        severity: 'success',
        title: '利润健康 ✓',
        message: `款式 ${input.style_no} 毛利率 ${input.margin_per_style.toFixed(1)}%，高于安全线 15%。`,
        suggestedAction: '维持当前成本结构，关注面料价格波动和汇率变化。',
        priority: 99,
      })
    }
  }

  return recs.sort((a, b) => a.priority - b.priority)
}

// ─────────────────────────────────────────────────────────────
// Order-level FX risk recommendation
// ─────────────────────────────────────────────────────────────

export function generateFXRecommendation(params: {
  currentRate: number
  lockedRate: number
  currentMargin: number
  lockedMargin: number
}): Recommendation | null {
  const marginDrop = params.lockedMargin - params.currentMargin
  if (Math.abs(marginDrop) < 0.5) return null

  if (marginDrop > 0) {
    const severity: RecommendationSeverity = marginDrop > 2 ? 'critical' : 'warning'
    return {
      type: 'exchange_rate_risk',
      severity,
      title: '汇率变动影响利润',
      message: `锁汇汇率 ${params.lockedRate}，当前市场汇率 ${params.currentRate}。汇率变化使毛利率下降 ${marginDrop.toFixed(1)} 个百分点（由 ${params.lockedMargin.toFixed(1)}% 降至 ${params.currentMargin.toFixed(1)}%）。`,
      suggestedAction: `如汇率继续走低，建议在下笔订单中适当提高售价或要求客户接受汇率条款。当前锁汇策略需重新评估。`,
      priority: 0,
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// Customer-level recommendation
// ─────────────────────────────────────────────────────────────

export function generateCustomerRecommendation(params: {
  customerName: string
  avgMargin: number
  avgPaymentDays: number
  orderCount: number
  grade: 'A' | 'B' | 'C' | 'D'
}): Recommendation {
  const gradeMessages: Record<string, { title: string; message: string; action: string; severity: RecommendationSeverity }> = {
    A: {
      title: '优质客户 — 重点维护',
      message: `${params.customerName} 平均毛利 ${params.avgMargin.toFixed(1)}%，账期 ${params.avgPaymentDays} 天。`,
      action: '建议给予优先排产、优先备货，保持长期合作关系。',
      severity: 'success',
    },
    B: {
      title: '优先客户 — 关注回款',
      message: `${params.customerName} 利润尚可（${params.avgMargin.toFixed(1)}%），但账期 ${params.avgPaymentDays} 天，资金占用较高。`,
      action: '建议与客户协商缩短账期（目标 ≤30天），或要求提前支付订金。',
      severity: 'info',
    },
    C: {
      title: '一般客户 — 提升利润',
      message: `${params.customerName} 利润偏低（${params.avgMargin.toFixed(1)}%），但账期较短（${params.avgPaymentDays} 天），现金流压力不大。`,
      action: '建议从成本端优化，或在下次报价时适度提价。',
      severity: 'warning',
    },
    D: {
      title: '高风险客户 — 谨慎接单',
      message: `${params.customerName} 利润低（${params.avgMargin.toFixed(1)}%）且账期长（${params.avgPaymentDays} 天），对公司资金占用大、回报低。`,
      action: '建议评估是否继续接单。如保留合作，应明确要求：涨价 OR 缩短账期，二选一。',
      severity: 'critical',
    },
  }

  const cfg = gradeMessages[params.grade]
  return {
    type: 'customer_margin_warning',
    severity: cfg.severity,
    title: cfg.title,
    message: cfg.message,
    suggestedAction: cfg.action,
    priority: params.grade === 'D' ? 1 : params.grade === 'C' ? 2 : params.grade === 'B' ? 3 : 4,
  }
}
