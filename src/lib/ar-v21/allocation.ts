import { money, moneyString } from './money'
import type { AllocationProposal, OpenReceivable, ReceiptBalanceInput } from './types'

export function validateAllocationProposal(
  proposal: AllocationProposal,
  receipt: ReceiptBalanceInput & { currency: string },
  receivable?: OpenReceivable,
) {
  if (!proposal.idempotencyKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED')
  const amount = money(proposal.amount)
  if (amount.lte(0)) throw new Error('ALLOCATION_AMOUNT_MUST_BE_POSITIVE')
  const receiptRemaining = money(receipt.grossAmount)
    .minus(receipt.approvedFeeAmount ?? 0)
    .minus(receipt.approvedDifferenceAmount ?? 0)
    .minus(receipt.approvedAllocationAmount ?? 0)
    .minus(receipt.refundedAmount ?? 0)
  if (amount.gt(receiptRemaining.plus(0.005))) throw new Error('ALLOCATION_EXCEEDS_RECEIPT_BALANCE')

  if (proposal.type === 'order_receivable' || proposal.type === 'deposit') {
    if (!receivable) throw new Error('RECEIVABLE_REQUIRED')
    const outstanding = money(receivable.originalAmount)
      .minus(receivable.approvedAdjustmentAmount ?? 0)
      .minus(receivable.approvedAllocationAmount ?? 0)
    if (amount.gt(outstanding.plus(0.005))) throw new Error('ALLOCATION_EXCEEDS_RECEIVABLE')
  }

  if (receivable && proposal.currency !== receivable.currency) {
    if (!proposal.exchangeRate || money(proposal.exchangeRate).lte(0)) throw new Error('APPROVED_EXCHANGE_RATE_REQUIRED')
    if (!proposal.cnyAmount || money(proposal.cnyAmount).lte(0)) throw new Error('CNY_EQUIVALENT_REQUIRED')
  }
  return { valid: true, amount: moneyString(amount), receiptRemaining: moneyString(receiptRemaining.minus(amount)) }
}

export function assertBalancedAllocations(receiptAmount: string | number, allocations: Array<{ amount: string | number; status: string }>) {
  const active = allocations.filter((item) => item.status === 'approved').reduce((sum, item) => sum.plus(item.amount), money(0))
  if (active.gt(money(receiptAmount).plus(0.005))) throw new Error('ALLOCATION_TOTAL_EXCEEDS_RECEIPT')
  return moneyString(money(receiptAmount).minus(active))
}
