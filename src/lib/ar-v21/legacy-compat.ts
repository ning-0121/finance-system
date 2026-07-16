export function legacyAllocationStatus(status: string | null | undefined, voidedAt: string | null | undefined) {
  if (voidedAt) return 'reversed' as const
  return status === 'proposed' || status === 'approved' || status === 'reversed' ? status : 'approved' as const
}

export function isActiveLegacyAllocation(row: { status?: string | null; voided_at?: string | null }) {
  return legacyAllocationStatus(row.status, row.voided_at) === 'approved'
}

export function legacyReceiptSource(source: string | null | undefined) {
  return source || 'legacy'
}
