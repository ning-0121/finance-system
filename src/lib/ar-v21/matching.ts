import { money, moneyString } from './money'
import type { BankMatchTransaction, MatchEvidence, MatchProposal, OpenReceivable, PayerMapping } from './types'

export function normalizeMatchText(value: string | null | undefined) {
  return (value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function containsReference(text: string, receivable: OpenReceivable) {
  return [receivable.orderNumber, ...(receivable.references || [])]
    .map(normalizeMatchText)
    .filter(Boolean)
    .some((ref) => text.includes(ref))
}

export function proposeCashApplication(
  transaction: BankMatchTransaction,
  receivables: OpenReceivable[],
  payerMappings: PayerMapping[] = [],
): MatchProposal {
  const amount = money(transaction.amount)
  const memo = normalizeMatchText(`${transaction.reference || ''} ${transaction.memo || ''}`)
  const payer = normalizeMatchText(transaction.counterpartyName)
  const account = normalizeMatchText(transaction.counterpartyAccountMasked)
  const candidates = receivables.filter((r) => r.currency === transaction.currency)
  const ranked = candidates.map((receivable) => {
    const evidence: MatchEvidence[] = []
    let score = 0
    if (containsReference(memo, receivable)) {
      score += 55
      evidence.push({ signal: 'exact_reference', weight: 55, detail: `摘要命中 ${receivable.orderNumber}` })
    }
    const names = [receivable.customerName, ...(receivable.aliases || [])].map(normalizeMatchText)
    if (payer && names.some((name) => name && (payer.includes(name) || name.includes(payer)))) {
      score += 25
      evidence.push({ signal: 'normalized_customer_name', weight: 25, detail: '付款户名命中客户或别名' })
    }
    const mapping = payerMappings.find((m) => m.customerId === receivable.customerId &&
      ((account && m.normalizedAccount === account) || (payer && m.normalizedName === payer)))
    if (mapping) {
      score += 35
      evidence.push({ signal: 'confirmed_payer_mapping', weight: 35, detail: `历史确认付款方(${mapping.confirmedCount || 1}次)` })
    }
    const outstanding = money(receivable.originalAmount)
      .minus(receivable.approvedAdjustmentAmount ?? 0)
      .minus(receivable.approvedAllocationAmount ?? 0)
    if (outstanding.eq(amount)) {
      score += 30
      evidence.push({ signal: 'exact_open_amount', weight: 30, detail: '金额与唯一未收余额一致' })
    }
    return { receivable, score, evidence, outstanding }
  }).sort((a, b) => b.score - a.score || a.receivable.orderNumber.localeCompare(b.receivable.orderNumber))

  const best = ranked[0]
  if (!best || best.score < 20) {
    return { customerId: null, receivableIds: [], confidence: 'low', evidence: [], conflicts: ['没有可靠客户或订单信号'], proposedAmount: '0.00', remainingUnapplied: moneyString(amount) }
  }
  const ties = ranked.filter((candidate) => candidate.score === best.score && candidate.receivable.customerId !== best.receivable.customerId)
  const proposed = best.outstanding.lt(amount) ? best.outstanding : amount
  const confidence = ties.length ? 'needs_review' : best.score >= 80 ? 'high' : best.score >= 50 ? 'medium' : 'low'
  return {
    customerId: best.receivable.customerId,
    receivableIds: [best.receivable.id],
    confidence,
    evidence: best.evidence,
    conflicts: ties.length ? ['多个客户具有同等匹配证据'] : [],
    proposedAmount: moneyString(proposed),
    remainingUnapplied: moneyString(amount.minus(proposed)),
  }
}

export const AI_MATCHING_POLICY = Object.freeze({ autoExecute: false, canApprove: false, maskAccountNumbers: true, output: 'proposal_only' as const })
