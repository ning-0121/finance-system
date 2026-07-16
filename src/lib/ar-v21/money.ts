import Decimal from 'decimal.js'
import type { DecimalInput, ReceiptBalanceInput } from './types'

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

export const money = (value: DecimalInput | null | undefined) => new Decimal(value ?? 0)
export const money2 = (value: DecimalInput | null | undefined) => money(value).toDecimalPlaces(2)
export const moneyString = (value: DecimalInput | Decimal) => new Decimal(value).toDecimalPlaces(2).toFixed(2)

export function calculateReceiptBalance(input: ReceiptBalanceInput) {
  const gross = money2(input.grossAmount)
  const fees = money2(input.approvedFeeAmount)
  const differences = money2(input.approvedDifferenceAmount)
  const allocated = money2(input.approvedAllocationAmount)
  const refunded = money2(input.refundedAmount)
  const allocatable = gross.minus(fees).minus(differences)
  const unapplied = allocatable.minus(allocated).minus(refunded)
  if (gross.isNegative() || fees.isNegative() || differences.isNegative() || allocated.isNegative() || refunded.isNegative()) {
    throw new Error('NEGATIVE_FINANCIAL_COMPONENT')
  }
  if (allocatable.isNegative()) throw new Error('DIFFERENCES_EXCEED_RECEIPT')
  if (unapplied.lt(-0.005)) throw new Error('RECEIPT_OVER_ALLOCATED')
  return {
    gross: moneyString(gross),
    allocatable: moneyString(allocatable),
    allocated: moneyString(allocated),
    unapplied: moneyString(Decimal.max(unapplied, 0)),
  }
}

export function calculateReceivableBalance(input: {
  originalAmount: DecimalInput
  approvedAdjustmentAmount?: DecimalInput
  approvedAllocationAmount?: DecimalInput
}) {
  const original = money2(input.originalAmount)
  const adjustments = money2(input.approvedAdjustmentAmount)
  const allocations = money2(input.approvedAllocationAmount)
  const net = original.minus(adjustments)
  const outstanding = net.minus(allocations)
  if (original.isNegative() || net.isNegative()) throw new Error('INVALID_NET_RECEIVABLE')
  return {
    original: moneyString(original),
    net: moneyString(net),
    settled: moneyString(allocations),
    outstanding: moneyString(Decimal.max(outstanding, 0)),
    credit: moneyString(Decimal.max(outstanding.negated(), 0)),
    status: outstanding.lt(-0.005) ? 'overpaid' : outstanding.lte(0.005) ? 'paid' : allocations.gt(0) ? 'partially_paid' : 'open',
  } as const
}
