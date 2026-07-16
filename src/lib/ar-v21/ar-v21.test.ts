import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { calculateReceiptBalance, calculateReceivableBalance } from '@/lib/ar-v21/money'
import { assertBalancedAllocations, validateAllocationProposal } from '@/lib/ar-v21/allocation'
import { parseBankStatement, bankTransactionFingerprint } from '@/lib/ar-v21/bank-import'
import { AI_MATCHING_POLICY, proposeCashApplication } from '@/lib/ar-v21/matching'
import { buildCustomerStatement } from '@/lib/ar-v21/customer-statement'
import { findOrderIntegrationException, reconcileReceipt } from '@/lib/ar-v21/reconciliation'
import { isActiveLegacyAllocation, legacyAllocationStatus } from '@/lib/ar-v21/legacy-compat'
import type { OpenReceivable } from '@/lib/ar-v21/types'

const receivable = (overrides: Partial<OpenReceivable> = {}): OpenReceivable => ({
  id: 'ar-a', orderId: 'order-a', orderNumber: 'QIMO-A', customerId: 'customer-a', customerName: 'Acme Ltd',
  currency: 'USD', originalAmount: '10000.00', approvedAdjustmentAmount: '0', approvedAllocationAmount: '0', ...overrides,
})

describe('AR V2.1 financial invariants', () => {
  it('A one receipt to one order reconciles', () => {
    expect(validateAllocationProposal({ idempotencyKey: 'a', receiptId: 'r', receivableId: 'ar-a', type: 'order_receivable', amount: '10000', currency: 'USD' }, { grossAmount: '10000', currency: 'USD' }, receivable()).receiptRemaining).toBe('0.00')
  })

  it('B three receipts settle one order without repeated multiplier', () => {
    expect(calculateReceivableBalance({ originalAmount: '10000', approvedAllocationAmount: '3000' }).status).toBe('partially_paid')
    expect(calculateReceivableBalance({ originalAmount: '10000', approvedAllocationAmount: '5500' }).outstanding).toBe('4500.00')
    expect(calculateReceivableBalance({ originalAmount: '10000', approvedAllocationAmount: '10000' }).status).toBe('paid')
  })

  it('C one receipt to three orders preserves remainder', () => {
    expect(assertBalancedAllocations('20000', [
      { amount: '8000', status: 'approved' }, { amount: '7000', status: 'approved' }, { amount: '4950', status: 'approved' },
    ])).toBe('50.00')
  })

  it('D bank fee settles consolidated receipt exactly', () => {
    expect(calculateReceiptBalance({ grossAmount: '20000', approvedFeeAmount: '50', approvedAllocationAmount: '19950' }).unapplied).toBe('0.00')
  })

  it('E deduction and rounding are distinct approved treatments', () => {
    const result = reconcileReceipt({ gross: '1000', allocations: [
      { amount: '990', status: 'approved', type: 'order_receivable' },
      { amount: '8', status: 'approved', type: 'customer_deduction' },
      { amount: '2', status: 'approved', type: 'rounding' },
    ] })
    expect(result).toMatchObject({ differences: '10.00', unapplied: '0.00', balanced: true })
  })

  it('F unknown payer remains fully unapplied', () => {
    const proposal = proposeCashApplication({ id: 'b', date: '2026-07-16', currency: 'USD', amount: '1234', counterpartyName: 'Unknown' }, [receivable()])
    expect(proposal).toMatchObject({ customerId: null, remainingUnapplied: '1234.00' })
  })

  it('G overpayment becomes explicit credit', () => {
    expect(calculateReceivableBalance({ originalAmount: '100', approvedAllocationAmount: '105' })).toMatchObject({ status: 'overpaid', credit: '5.00' })
  })

  it('H reversal excludes the original allocation', () => {
    expect(assertBalancedAllocations('100', [{ amount: '100', status: 'reversed' }, { amount: '90', status: 'approved' }])).toBe('10.00')
  })

  it('K partial allocation never marks paid', () => {
    expect(calculateReceivableBalance({ originalAmount: '100', approvedAllocationAmount: '40' })).toMatchObject({ status: 'partially_paid', outstanding: '60.00' })
  })

  it('L mixed currency requires an explicit rate and CNY equivalent', () => {
    const proposal = { idempotencyKey: 'fx', receiptId: 'r', receivableId: 'ar', type: 'order_receivable' as const, amount: '100', currency: 'CNY' }
    expect(() => validateAllocationProposal(proposal, { grossAmount: '100', currency: 'CNY' }, receivable({ originalAmount: '100' }))).toThrow('APPROVED_EXCHANGE_RATE_REQUIRED')
  })

  it('M customer statement ending balance equals ledger', () => {
    const statement = buildCustomerStatement({ customerId: 'c', currency: 'USD', periodStart: '2026-01-01', periodEnd: '2026-12-31', receivables: [
      { id: 'i', date: '2026-01-02', documentNo: 'INV-1', currency: 'USD', amount: '1000' },
    ], movements: [{ id: 'p', date: '2026-01-03', kind: 'allocation', reference: 'PAY-1', currency: 'USD', amount: '400', status: 'approved' }] })
    expect(statement.endingBalance).toBe('600.00')
    expect(statement.sourceSnapshotHash).toHaveLength(64)
  })

  it('N order revision mismatch enters exception queue', () => {
    expect(findOrderIntegrationException({ orderId: 'o', currency: 'USD', amount: '100', sourceVersion: 1 }, { id: 'o', currency: 'USD', amount: '110', sourceVersion: 2 }).reasons).toEqual(['AMOUNT_MISMATCH','SOURCE_VERSION_MISMATCH'])
  })

  it('O refund reduces unapplied cash and stays auditable', () => {
    expect(reconcileReceipt({ gross: '100', allocations: [], refunds: [{ amount: '25', status: 'approved' }] }).unapplied).toBe('75.00')
  })

  it('P write-off remains an approved adjustment rather than receipt', () => {
    expect(calculateReceivableBalance({ originalAmount: '100', approvedAdjustmentAmount: '100' }).status).toBe('paid')
  })

  it('S repeated statement input produces the same hash', () => {
    const input = { customerId: 'c', currency: 'CNY', periodStart: '2026-01-01', periodEnd: '2026-01-31', receivables: [], movements: [] }
    expect(buildCustomerStatement(input).sourceSnapshotHash).toBe(buildCustomerStatement(input).sourceSnapshotHash)
  })

  it('T date-only input does not shift timezone', () => {
    const csv = new TextEncoder().encode('交易日期,贷方金额,币种\n2026-07-16,100,CNY')
    expect(parseBankStatement(csv, '中国银行流水.csv', '00000000-0000-4000-8000-000000000001').rows[0].transactionDate).toBe('2026-07-16')
  })
})

describe('bank import and deterministic matching', () => {
  it('I duplicate import checksum is stable', () => {
    const csv = new TextEncoder().encode('交易日期,贷方金额\n2026-07-16,100')
    expect(parseBankStatement(csv, '流水.csv', '00000000-0000-4000-8000-000000000001').checksum)
      .toBe(parseBankStatement(csv, '流水.csv', '00000000-0000-4000-8000-000000000001').checksum)
  })

  it('J duplicate transaction across files has stable fingerprint', () => {
    const row = { bankAccountId: 'bank', transactionDate: '2026-07-16', valueDate: null, direction: 'credit' as const, currency: 'USD', amount: '100.00', balance: null, counterpartyName: 'ACME', counterpartyAccountMasked: '1234****5678', reference: 'R1', memo: null }
    expect(bankTransactionFingerprint(row)).toBe(bankTransactionFingerprint(row))
  })

  it('parses XLSX deterministically with Chinese headers', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['交易日期','收入','币种','对方户名','流水号'],['2026-07-16',200,'USD','Acme Ltd','QIMO-A']]), '流水')
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    expect(parseBankStatement(new Uint8Array(bytes), '银行 流水.xlsx', '00000000-0000-4000-8000-000000000001').rows[0]).toMatchObject({ direction: 'credit', amount: '200.00' })
  })

  it('exact reference plus exact amount gives explained high confidence', () => {
    const result = proposeCashApplication({ id: 'b', date: '2026-07-16', currency: 'USD', amount: '10000', reference: 'QIMO-A', counterpartyName: 'Acme Ltd' }, [receivable()])
    expect(result.confidence).toBe('high')
    expect(result.evidence.map(e => e.signal)).toEqual(expect.arrayContaining(['exact_reference','normalized_customer_name','exact_open_amount']))
  })

  it('amount-only suggestion stays low confidence', () => {
    expect(proposeCashApplication({ id: 'b', date: '2026-07-16', currency: 'USD', amount: '10000' }, [receivable()]).confidence).toBe('low')
  })
})

describe('authorization, AI safety, legacy compatibility, and migration safety', () => {
  it('Q migration has server-only writes and manager approval RPC', () => {
    const sql = readFileSync(resolve(process.cwd(), 'migrations/20260716_ar_v21_reconciliation.sql'), 'utf8')
    expect(sql).toContain("v_role NOT IN ('finance_manager','admin')")
    expect(sql).toContain('auth.uid()')
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE)\s+(?:FROM|TABLE)\b/i)
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|CONSTRAINT)\b/i)
  })

  it('R AI output can never approve or execute', () => {
    expect(AI_MATCHING_POLICY).toEqual({ autoExecute: false, canApprove: false, maskAccountNumbers: true, output: 'proposal_only' })
  })

  it('legacy active allocations read as approved without backfill', () => {
    expect(legacyAllocationStatus(null, null)).toBe('approved')
    expect(isActiveLegacyAllocation({ status: null, voided_at: null })).toBe(true)
    expect(isActiveLegacyAllocation({ status: null, voided_at: '2026-01-01' })).toBe(false)
  })

  it('financial calculations reject unexplained negative outstanding', () => {
    expect(() => calculateReceiptBalance({ grossAmount: '100', approvedAllocationAmount: '101' })).toThrow('RECEIPT_OVER_ALLOCATED')
  })
})
