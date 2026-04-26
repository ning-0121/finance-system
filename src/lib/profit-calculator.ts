// ============================================================
// Profit Control Center — Core Calculation Engine
// All money arithmetic uses Decimal.js to avoid IEEE 754 errors
// ============================================================

import Decimal from 'decimal.js'

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface StyleInput {
  selling_price_per_piece_usd: number
  fabric_usage_kg_per_piece: number
  fabric_price_per_kg_rmb: number
  cmt_cost_per_piece_rmb: number
  trim_cost_per_piece_rmb: number
  packing_cost_per_piece_rmb: number
  freight_cost_per_piece_usd: number
  other_cost_per_piece_rmb: number
  exchange_rate: number
}

export interface StyleResult {
  fabric_cost_per_piece_rmb: number
  fabric_cost_per_piece_usd: number
  rmb_cost_per_piece_rmb: number           // total RMB-denominated costs
  rmb_cost_as_usd: number                  // RMB costs converted to USD
  total_cost_per_piece_usd: number         // full cost in USD
  profit_per_piece_usd: number
  margin_per_style: number                 // percentage, 0–100
}

export interface OrderStyleRow {
  qty: number
  styleResult: StyleResult
}

export interface OrderProfit {
  total_qty: number
  sales_amount_usd: number
  total_cost_usd: number
  gross_profit_usd: number
  gross_margin: number                     // percentage
}

export interface FXScenario {
  rate: number
  total_cost_usd: number
  gross_profit_usd: number
  gross_margin: number
  profit_change_usd: number
  profit_change_pct: number
}

// ─────────────────────────────────────────────────────────────
// 1. Fabric cost per piece (RMB)
// ─────────────────────────────────────────────────────────────

export function calculateFabricCostPerPiece(
  fabricUsageKgPerPiece: number,
  fabricPricePerKgRmb: number
): number {
  return new Decimal(fabricUsageKgPerPiece)
    .mul(new Decimal(fabricPricePerKgRmb))
    .toDecimalPlaces(4)
    .toNumber()
}

// ─────────────────────────────────────────────────────────────
// 2. Convert RMB → USD
// ─────────────────────────────────────────────────────────────

export function convertRmbToUsd(amountRmb: number, exchangeRate: number): number {
  if (!exchangeRate || exchangeRate <= 0) return 0
  return new Decimal(amountRmb)
    .div(new Decimal(exchangeRate))
    .toDecimalPlaces(4)
    .toNumber()
}

// ─────────────────────────────────────────────────────────────
// 3. Full style profit calculation
// ─────────────────────────────────────────────────────────────

export function calculateStyleProfit(input: StyleInput): StyleResult {
  const rate = input.exchange_rate > 0 ? input.exchange_rate : 7

  const fabricCostRmb = calculateFabricCostPerPiece(
    input.fabric_usage_kg_per_piece,
    input.fabric_price_per_kg_rmb
  )

  // Sum of all RMB costs
  const totalRmbCost = new Decimal(fabricCostRmb)
    .plus(input.cmt_cost_per_piece_rmb)
    .plus(input.trim_cost_per_piece_rmb)
    .plus(input.packing_cost_per_piece_rmb)
    .plus(input.other_cost_per_piece_rmb)

  const rmbCostAsUsd = convertRmbToUsd(totalRmbCost.toNumber(), rate)

  // Add freight (already in USD)
  const totalCostUsd = new Decimal(rmbCostAsUsd)
    .plus(input.freight_cost_per_piece_usd)
    .toDecimalPlaces(4)
    .toNumber()

  const profitUsd = new Decimal(input.selling_price_per_piece_usd)
    .minus(totalCostUsd)
    .toDecimalPlaces(4)
    .toNumber()

  const margin = input.selling_price_per_piece_usd > 0
    ? new Decimal(profitUsd)
        .div(new Decimal(input.selling_price_per_piece_usd))
        .mul(100)
        .toDecimalPlaces(2)
        .toNumber()
    : 0

  return {
    fabric_cost_per_piece_rmb: new Decimal(fabricCostRmb).toDecimalPlaces(2).toNumber(),
    fabric_cost_per_piece_usd: convertRmbToUsd(fabricCostRmb, rate),
    rmb_cost_per_piece_rmb: totalRmbCost.toDecimalPlaces(2).toNumber(),
    rmb_cost_as_usd: rmbCostAsUsd,
    total_cost_per_piece_usd: totalCostUsd,
    profit_per_piece_usd: profitUsd,
    margin_per_style: margin,
  }
}

// ─────────────────────────────────────────────────────────────
// 4. Aggregate order profit from multiple styles
// ─────────────────────────────────────────────────────────────

export function calculateOrderProfit(styles: OrderStyleRow[]): OrderProfit {
  if (styles.length === 0) {
    return { total_qty: 0, sales_amount_usd: 0, total_cost_usd: 0, gross_profit_usd: 0, gross_margin: 0 }
  }

  let totalQty = new Decimal(0)
  let totalSales = new Decimal(0)
  let totalCost = new Decimal(0)

  for (const { qty, styleResult } of styles) {
    const q = new Decimal(qty)
    totalQty = totalQty.plus(q)
    // Note: selling_price_per_piece_usd is not in StyleResult — caller must pass it
    totalCost = totalCost.plus(q.mul(styleResult.total_cost_per_piece_usd))
  }

  const grossProfit = totalSales.minus(totalCost)
  const grossMargin = totalSales.gt(0)
    ? grossProfit.div(totalSales).mul(100).toDecimalPlaces(2).toNumber()
    : 0

  return {
    total_qty: totalQty.toNumber(),
    sales_amount_usd: totalSales.toDecimalPlaces(2).toNumber(),
    total_cost_usd: totalCost.toDecimalPlaces(2).toNumber(),
    gross_profit_usd: grossProfit.toDecimalPlaces(2).toNumber(),
    gross_margin: grossMargin,
  }
}

// ─────────────────────────────────────────────────────────────
// 4b. Calculate order profit from BudgetOrder fields
//     (for orders without per-style breakdown)
// ─────────────────────────────────────────────────────────────

export function calculateOrderProfitFromBudget(
  totalRevenueUsd: number,
  totalCostRmb: number,
  exchangeRate: number,
  currency: string = 'USD'
): OrderProfit {
  const rate = exchangeRate > 0 ? exchangeRate : 7

  // Convert revenue to USD if in RMB
  const salesUsd = currency === 'USD'
    ? new Decimal(totalRevenueUsd)
    : new Decimal(totalRevenueUsd).div(rate)

  // Cost is in RMB, convert to USD
  const costUsd = new Decimal(totalCostRmb).div(rate)

  const profit = salesUsd.minus(costUsd)
  const margin = salesUsd.gt(0)
    ? profit.div(salesUsd).mul(100).toDecimalPlaces(2).toNumber()
    : 0

  return {
    total_qty: 0,
    sales_amount_usd: salesUsd.toDecimalPlaces(2).toNumber(),
    total_cost_usd: costUsd.toDecimalPlaces(2).toNumber(),
    gross_profit_usd: profit.toDecimalPlaces(2).toNumber(),
    gross_margin: margin,
  }
}

// ─────────────────────────────────────────────────────────────
// 5. FX impact simulator
//    Baseline = order using its locked rate
//    Scenarios = same costs, different exchange rates
// ─────────────────────────────────────────────────────────────

export function simulateExchangeRateImpact(params: {
  totalRevenueUsd: number        // fixed (USD selling price doesn't change)
  totalCostRmb: number           // fixed in RMB
  lockedRate: number             // the rate baked into the order
  scenarios?: number[]           // extra rates to test
}): FXScenario[] {
  const { totalRevenueUsd, totalCostRmb, lockedRate } = params
  const DEFAULT_RATES = [6.7, 6.8, 6.9, 7.0, 7.1, 7.2]
  const rates = [...new Set([...(params.scenarios ?? DEFAULT_RATES), lockedRate])].sort((a, b) => a - b)

  // Baseline at locked rate
  const baseCostUsd = new Decimal(totalCostRmb).div(lockedRate)
  const baseProfit = new Decimal(totalRevenueUsd).minus(baseCostUsd)

  return rates.map(rate => {
    const costUsd = new Decimal(totalCostRmb).div(rate)
    const profit = new Decimal(totalRevenueUsd).minus(costUsd)
    const margin = new Decimal(totalRevenueUsd).gt(0)
      ? profit.div(totalRevenueUsd).mul(100).toDecimalPlaces(2).toNumber()
      : 0
    const profitChange = profit.minus(baseProfit).toDecimalPlaces(2).toNumber()
    const profitChangePct = baseProfit.gt(0)
      ? profit.minus(baseProfit).div(baseProfit).mul(100).toDecimalPlaces(2).toNumber()
      : 0

    // Risk level based on margin
    return {
      rate,
      total_cost_usd: costUsd.toDecimalPlaces(2).toNumber(),
      gross_profit_usd: profit.toDecimalPlaces(2).toNumber(),
      gross_margin: margin,
      profit_change_usd: profitChange,
      profit_change_pct: profitChangePct,
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 6. Margin risk classification
// ─────────────────────────────────────────────────────────────

export type MarginRisk = 'critical' | 'warning' | 'healthy'

export function classifyMarginRisk(margin: number): MarginRisk {
  if (margin < 10) return 'critical'
  if (margin < 15) return 'warning'
  return 'healthy'
}

export const RISK_CONFIG = {
  critical: { label: '风险', color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', badge: 'destructive' as const },
  warning:  { label: '预警', color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', badge: 'secondary' as const },
  healthy:  { label: '健康', color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200', badge: 'default' as const },
}

// ─────────────────────────────────────────────────────────────
// 7. Customer grade (A/B/C/D)
// ─────────────────────────────────────────────────────────────

export type CustomerGrade = 'A' | 'B' | 'C' | 'D'

export function gradeCustomer(avgMargin: number, avgPaymentTermsDays: number): CustomerGrade {
  const highMargin = avgMargin >= 15
  const shortTerms = avgPaymentTermsDays <= 45
  if (highMargin && shortTerms) return 'A'
  if (highMargin && !shortTerms) return 'B'
  if (!highMargin && shortTerms) return 'C'
  return 'D'
}

export const GRADE_CONFIG = {
  A: { label: 'A — 优质', color: 'text-green-700', bg: 'bg-green-50', desc: '利润高 + 账期短' },
  B: { label: 'B — 优先', color: 'text-blue-700', bg: 'bg-blue-50', desc: '利润高 + 账期长' },
  C: { label: 'C — 一般', color: 'text-amber-700', bg: 'bg-amber-50', desc: '利润低 + 账期短' },
  D: { label: 'D — 风险', color: 'text-red-700', bg: 'bg-red-50', desc: '利润低 + 账期长' },
}
