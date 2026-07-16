export type DecimalInput = string | number

export type AllocationStatus = 'proposed' | 'approved' | 'reversed'
export type AllocationType =
  | 'order_receivable'
  | 'deposit'
  | 'bank_fee'
  | 'rounding'
  | 'customer_deduction'
  | 'credit_note'
  | 'unapplied'
  | 'refund'
  | 'other'

export interface OpenReceivable {
  id: string
  orderId: string
  orderNumber: string
  customerId: string
  customerName: string
  aliases?: string[]
  currency: string
  originalAmount: DecimalInput
  approvedAdjustmentAmount?: DecimalInput
  approvedAllocationAmount?: DecimalInput
  dueDate?: string | null
  references?: string[]
}

export interface ReceiptBalanceInput {
  grossAmount: DecimalInput
  approvedFeeAmount?: DecimalInput
  approvedDifferenceAmount?: DecimalInput
  approvedAllocationAmount?: DecimalInput
  refundedAmount?: DecimalInput
}

export interface AllocationProposal {
  idempotencyKey: string
  receiptId: string
  receivableId?: string
  orderId?: string
  type: AllocationType
  amount: DecimalInput
  currency: string
  exchangeRate?: DecimalInput
  cnyAmount?: DecimalInput
}

export interface BankMatchTransaction {
  id: string
  date: string
  valueDate?: string | null
  currency: string
  amount: DecimalInput
  counterpartyName?: string | null
  reference?: string | null
  memo?: string | null
  counterpartyAccountMasked?: string | null
}

export interface PayerMapping {
  customerId: string
  normalizedAccount?: string | null
  normalizedName?: string | null
  confirmedCount?: number
}

export interface MatchEvidence {
  signal: string
  weight: number
  detail: string
}

export interface MatchProposal {
  customerId: string | null
  receivableIds: string[]
  confidence: 'high' | 'medium' | 'low' | 'needs_review'
  evidence: MatchEvidence[]
  conflicts: string[]
  proposedAmount: string
  remainingUnapplied: string
}

export interface StatementReceivableLine {
  id: string
  date: string
  documentNo: string
  orderNumber?: string
  currency: string
  amount: DecimalInput
  cnyAmount?: DecimalInput
}

export interface StatementMovement {
  id: string
  date: string
  kind: 'adjustment' | 'allocation' | 'credit_note' | 'refund'
  reference: string
  currency: string
  amount: DecimalInput
  cnyAmount?: DecimalInput
  status: 'approved' | 'reversed'
}
