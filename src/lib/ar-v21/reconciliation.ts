import { money, moneyString } from './money'

export function reconcileReceipt(input: {
  gross: string | number
  allocations: Array<{ amount: string | number; status: 'proposed' | 'approved' | 'reversed'; type: string }>
  refunds?: Array<{ amount: string | number; status: 'approved' | 'reversed' }>
}) {
  const approved = input.allocations.filter((a) => a.status === 'approved')
  const allocated = approved.filter((a) => !['bank_fee', 'rounding', 'customer_deduction'].includes(a.type)).reduce((sum, a) => sum.plus(a.amount), money(0))
  const differences = approved.filter((a) => ['bank_fee', 'rounding', 'customer_deduction'].includes(a.type)).reduce((sum, a) => sum.plus(a.amount), money(0))
  const refunded = (input.refunds || []).filter((r) => r.status === 'approved').reduce((sum, r) => sum.plus(r.amount), money(0))
  const unapplied = money(input.gross).minus(allocated).minus(differences).minus(refunded)
  return {
    gross: moneyString(input.gross), allocated: moneyString(allocated), differences: moneyString(differences),
    refunded: moneyString(refunded), unapplied: moneyString(unapplied), balanced: unapplied.gte(-0.005),
  }
}

export function findOrderIntegrationException(finance: { orderId: string; currency: string; amount: string | number; sourceVersion: number }, order: { id: string; currency: string; amount: string | number; sourceVersion: number }) {
  const reasons: string[] = []
  if (finance.orderId !== order.id) reasons.push('ORDER_ID_MISMATCH')
  if (finance.currency !== order.currency) reasons.push('CURRENCY_MISMATCH')
  if (!money(finance.amount).eq(order.amount)) reasons.push('AMOUNT_MISMATCH')
  if (finance.sourceVersion !== order.sourceVersion) reasons.push('SOURCE_VERSION_MISMATCH')
  return { reconciled: reasons.length === 0, reasons }
}
