/**
 * Unit tests for profit-calculator and profit-recommendation-engine
 * Run with: npx tsx tests/profit-calculator.test.ts
 */

import {
  calculateFabricCostPerPiece,
  convertRmbToUsd,
  calculateStyleProfit,
  calculateOrderProfitFromBudget,
  simulateExchangeRateImpact,
  classifyMarginRisk,
  gradeCustomer,
  type StyleInput,
} from '../src/lib/profit-calculator'

import {
  generateStyleRecommendations,
  generateFXRecommendation,
  generateCustomerRecommendation,
  type StyleAnalysisInput,
} from '../src/lib/profit-recommendation-engine'

// ─── Simple assertion helper ──────────────────────────────────────────────────

let passed = 0
let failed = 0

function approx(a: number, b: number, tol = 0.01) {
  return Math.abs(a - b) <= tol
}

function assert(condition: boolean, label: string, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

function section(title: string) {
  console.log(`\n── ${title} ──`)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

section('calculateFabricCostPerPiece')
assert(
  approx(calculateFabricCostPerPiece(0.5, 30), 15),
  '0.5 kg × ¥30/kg = ¥15'
)
assert(
  approx(calculateFabricCostPerPiece(1.2, 25), 30),
  '1.2 kg × ¥25/kg = ¥30'
)
assert(
  calculateFabricCostPerPiece(0, 30) === 0,
  '0 kg → ¥0'
)

section('convertRmbToUsd')
assert(
  approx(convertRmbToUsd(700, 7), 100),
  '¥700 ÷ 7 = $100'
)
assert(
  approx(convertRmbToUsd(71.5, 7.15), 10),
  '¥71.5 ÷ 7.15 = $10'
)

section('calculateStyleProfit')
const styleInput: StyleInput = {
  selling_price_per_piece_usd: 15,
  fabric_usage_kg_per_piece: 0.5,
  fabric_price_per_kg_rmb: 30,
  cmt_cost_per_piece_rmb: 20,
  trim_cost_per_piece_rmb: 5,
  packing_cost_per_piece_rmb: 3,
  freight_cost_per_piece_usd: 0.5,
  other_cost_per_piece_rmb: 0,
  exchange_rate: 7,
}

const styleResult = calculateStyleProfit(styleInput)
// fabric cost = 0.5 * 30 = 15 RMB = 15/7 USD ≈ 2.143
// total RMB cost/piece = 15 + 20 + 5 + 3 = 43 → USD = 43/7 ≈ 6.143
// total cost/piece = 6.143 + 0.5 freight = 6.643
// revenue/piece = 15, profit/piece = 15 - 6.643 = 8.357
// margin = 8.357 / 15 = 55.7%
assert(styleResult.total_cost_per_piece_usd > 0, 'total cost > 0')
assert(approx(styleResult.margin_per_style, 55.7, 1), `margin ≈ 55.7% (got ${styleResult.margin_per_style.toFixed(2)}%)`)
assert(styleResult.fabric_cost_per_piece_rmb === 15, 'fabric cost = ¥15')
assert(styleResult.profit_per_piece_usd > 0, 'profit per piece > 0')

section('calculateOrderProfitFromBudget')
const orderProfit = calculateOrderProfitFromBudget(10000, 50000, 7, 'USD')
// revenue = $10000, cost = ¥50000 = $7143
// profit = $2857, margin = 28.57%
assert(approx(orderProfit.sales_amount_usd, 10000, 1), 'revenue = $10000')
assert(approx(orderProfit.total_cost_usd, 7142.86, 10), `cost ≈ $7143 (got ${orderProfit.total_cost_usd.toFixed(2)})`)
assert(approx(orderProfit.gross_profit_usd, 2857.14, 10), `profit ≈ $2857 (got ${orderProfit.gross_profit_usd.toFixed(2)})`)
assert(approx(orderProfit.gross_margin, 28.57, 0.5), `margin ≈ 28.57% (got ${orderProfit.gross_margin.toFixed(2)}%)`)

// Test loss scenario
const lossProfit = calculateOrderProfitFromBudget(5000, 80000, 7, 'USD')
assert(lossProfit.gross_profit_usd < 0, 'loss scenario: profit < 0')
assert(lossProfit.gross_margin < 0, 'loss scenario: margin < 0')

section('simulateExchangeRateImpact')
const scenarios = simulateExchangeRateImpact({
  totalRevenueUsd: 100000,
  totalCostRmb: 500000,
  lockedRate: 7.0,
})
assert(scenarios.length >= 5, `at least 5 FX scenarios (got ${scenarios.length})`)
const lockedScenario = scenarios.find(s => s.rate === 7.0)
assert(!!lockedScenario, 'locked rate scenario exists')
if (lockedScenario) {
  assert(approx(lockedScenario.total_cost_usd, 71428.57, 10), 'locked scenario cost ≈ $71429')
  assert(approx(lockedScenario.gross_margin, 28.57, 0.5), 'locked scenario margin ≈ 28.57%')
}
// Lower rate = RMB costs more in USD = lower margin
const s67 = scenarios.find(s => s.rate === 6.7)
const s72 = scenarios.find(s => s.rate === 7.2)
if (s67 && s72) {
  assert(s67.gross_margin < s72.gross_margin, 'lower rate → lower margin (costs more in USD)')
}
// profit_change_usd: at locked rate = 0, at higher rate = positive gain
const higherRate = scenarios.find(s => s.rate > 7.0)
if (higherRate) {
  assert(higherRate.profit_change_usd > 0, 'higher FX rate → positive profit change vs locked rate')
}

section('classifyMarginRisk')
assert(classifyMarginRisk(20) === 'healthy', '20% → healthy')
assert(classifyMarginRisk(15) === 'healthy', '15% → healthy (boundary)')
assert(classifyMarginRisk(14.9) === 'warning', '14.9% → warning')
assert(classifyMarginRisk(10) === 'warning', '10% → warning (boundary)')
assert(classifyMarginRisk(9.9) === 'critical', '9.9% → critical')
assert(classifyMarginRisk(0) === 'critical', '0% → critical')
assert(classifyMarginRisk(-5) === 'critical', 'negative → critical')

section('gradeCustomer')
assert(gradeCustomer(20, 30) === 'A', 'high margin + short terms → A')
assert(gradeCustomer(20, 90) === 'B', 'high margin + long terms → B')
assert(gradeCustomer(10, 30) === 'C', 'low margin + short terms → C')
assert(gradeCustomer(10, 90) === 'D', 'low margin + long terms → D')
// Boundary: 15% margin threshold, 45-day terms threshold (implementation uses <= 45)
assert(gradeCustomer(15, 45) === 'A', '15% + 45 days → A (boundary)')
assert(gradeCustomer(15, 46) === 'B', '15% + 46 days → B (just over threshold)')
assert(gradeCustomer(14.9, 45) === 'C', '14.9% + 45 days → C (low margin + short terms)')
assert(gradeCustomer(14.9, 46) === 'D', '14.9% + 46 days → D (low margin + long terms)')

// Note: CMT/fabric recommendations require a benchmark (b?.target_*) to trigger.
// Without a benchmark only margin-risk warnings fire. We provide benchmarks here.

section('generateStyleRecommendations — high CMT with benchmark')
const highCmtStyle: StyleInput = {
  selling_price_per_piece_usd: 10,
  fabric_usage_kg_per_piece: 0.4,
  fabric_price_per_kg_rmb: 30,
  cmt_cost_per_piece_rmb: 45,   // well above benchmark target of 20
  trim_cost_per_piece_rmb: 2,
  packing_cost_per_piece_rmb: 2,
  freight_cost_per_piece_usd: 0.3,
  other_cost_per_piece_rmb: 0,
  exchange_rate: 7,
}
const highCmtResult = calculateStyleProfit(highCmtStyle)
const highCmtInput: StyleAnalysisInput = {
  style_no: 'S001',
  product_category: 'leggings',
  size_type: 'missy',
  selling_price_per_piece_usd: highCmtStyle.selling_price_per_piece_usd,
  fabric_usage_kg_per_piece: highCmtStyle.fabric_usage_kg_per_piece,
  fabric_price_per_kg_rmb: highCmtStyle.fabric_price_per_kg_rmb,
  cmt_cost_per_piece_rmb: highCmtStyle.cmt_cost_per_piece_rmb,
  trim_cost_per_piece_rmb: highCmtStyle.trim_cost_per_piece_rmb,
  packing_cost_per_piece_rmb: highCmtStyle.packing_cost_per_piece_rmb,
  freight_cost_per_piece_usd: highCmtStyle.freight_cost_per_piece_usd,
  other_cost_per_piece_rmb: highCmtStyle.other_cost_per_piece_rmb,
  exchange_rate: highCmtStyle.exchange_rate,
  margin_per_style: highCmtResult.margin_per_style,
  total_cost_per_piece_usd: highCmtResult.total_cost_per_piece_usd,
  benchmark: {
    product_category: 'leggings',
    size_type: 'missy',
    target_cmt_cost_rmb: 20,           // actual CMT is 45 — way above 20 * 1.05
    target_fabric_price_per_kg_rmb: 30,
    target_fabric_usage_kg: 0.4,
    target_trim_cost_rmb: 3,
    target_packing_cost_rmb: 2,
    target_margin: 15,
  },
}
const cmtRecs = generateStyleRecommendations(highCmtInput)
assert(cmtRecs.length > 0, 'recommendations generated for high-CMT style')
const cmtRec = cmtRecs.find(r => r.type === 'reduce_cmt')
assert(!!cmtRec, 'reduce_cmt recommendation present for high CMT vs benchmark')

section('generateStyleRecommendations — high fabric cost with benchmark')
const highFabricStyle: StyleInput = {
  selling_price_per_piece_usd: 12,
  fabric_usage_kg_per_piece: 1.5,   // high usage
  fabric_price_per_kg_rmb: 60,      // expensive: 60 vs benchmark 25 → > 25 * 1.08
  cmt_cost_per_piece_rmb: 15,
  trim_cost_per_piece_rmb: 2,
  packing_cost_per_piece_rmb: 2,
  freight_cost_per_piece_usd: 0.3,
  other_cost_per_piece_rmb: 0,
  exchange_rate: 7,
}
const highFabricResult = calculateStyleProfit(highFabricStyle)
const highFabricInput: StyleAnalysisInput = {
  style_no: 'S002',
  product_category: 'leggings',
  size_type: 'missy',
  selling_price_per_piece_usd: highFabricStyle.selling_price_per_piece_usd,
  fabric_usage_kg_per_piece: highFabricStyle.fabric_usage_kg_per_piece,
  fabric_price_per_kg_rmb: highFabricStyle.fabric_price_per_kg_rmb,
  cmt_cost_per_piece_rmb: highFabricStyle.cmt_cost_per_piece_rmb,
  trim_cost_per_piece_rmb: highFabricStyle.trim_cost_per_piece_rmb,
  packing_cost_per_piece_rmb: highFabricStyle.packing_cost_per_piece_rmb,
  freight_cost_per_piece_usd: highFabricStyle.freight_cost_per_piece_usd,
  other_cost_per_piece_rmb: highFabricStyle.other_cost_per_piece_rmb,
  exchange_rate: highFabricStyle.exchange_rate,
  margin_per_style: highFabricResult.margin_per_style,
  total_cost_per_piece_usd: highFabricResult.total_cost_per_piece_usd,
  benchmark: {
    product_category: 'leggings',
    size_type: 'missy',
    target_fabric_price_per_kg_rmb: 25,  // actual = 60 → 60 > 25 * 1.08 = 27 ✓
    target_fabric_usage_kg: 0.8,          // actual = 1.5 → 1.5 > 0.8 * 1.10 = 0.88 ✓
    target_cmt_cost_rmb: 20,
    target_trim_cost_rmb: 3,
    target_packing_cost_rmb: 2,
    target_margin: 15,
  },
}
const fabricRecs = generateStyleRecommendations(highFabricInput)
const fabricRec = fabricRecs.find(r => r.type === 'reduce_fabric_price' || r.type === 'reduce_fabric_usage')
assert(!!fabricRec, 'fabric recommendation present for high fabric cost vs benchmark')

section('generateFXRecommendation')
// Rate dropped from 7.0 locked to 6.8 market: costs more in USD, margin drops
// locked margin: revenue $50K, cost ¥500K @ 7.0 = $71428 → profit $28571 ≈ 28.57%
// current margin: same cost @ 6.8 = $73529 → profit $26470 ≈ 22.94% (not quite right, but direction clear)
const lockedMargin = calculateOrderProfitFromBudget(50000, 350000, 7.0, 'USD').gross_margin
const currentMargin = calculateOrderProfitFromBudget(50000, 350000, 6.8, 'USD').gross_margin
const fxRec = generateFXRecommendation({
  lockedRate: 7.0,
  currentRate: 6.8,
  lockedMargin,
  currentMargin,
})
assert(fxRec !== null, 'FX recommendation generated when rate drops significantly')
if (fxRec) {
  assert(typeof fxRec.message === 'string', 'FX rec has message')
  assert(fxRec.type === 'exchange_rate_risk', 'FX rec type is "exchange_rate_risk"')
}

// No recommendation when rates are identical (no margin change)
const noFxRec = generateFXRecommendation({
  lockedRate: 7.0,
  currentRate: 7.0,
  lockedMargin: 25,
  currentMargin: 25,
})
assert(noFxRec === null, 'no FX recommendation when margin unchanged')

section('generateCustomerRecommendation')
const aRec = generateCustomerRecommendation({
  customerName: 'Acme Corp',
  avgMargin: 20,
  avgPaymentDays: 30,
  orderCount: 5,
  grade: 'A',
})
assert(aRec.severity === 'success', 'Grade A → success severity')

const dRec = generateCustomerRecommendation({
  customerName: 'Risky Co',
  avgMargin: 8,
  avgPaymentDays: 90,
  orderCount: 2,
  grade: 'D',
})
assert(dRec.severity === 'critical', 'Grade D → critical severity')
assert(typeof dRec.suggestedAction === 'string', 'Grade D has suggested action')

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\n❌ Some tests failed!')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed!')
}
