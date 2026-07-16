const enabled = (name: string) => process.env[name] === 'true'

export const arFlags = Object.freeze({
  receipts: () => enabled('AR_V2_RECEIPTS'),
  adjustments: () => enabled('AR_V2_ADJUSTMENTS'),
  bankImport: () => enabled('AR_V21_BANK_IMPORT'),
  allocations: () => enabled('AR_V21_ALLOCATIONS'),
  statements: () => enabled('AR_V21_STATEMENTS'),
  aiMatching: () => enabled('AR_V21_AI_MATCHING'),
})
