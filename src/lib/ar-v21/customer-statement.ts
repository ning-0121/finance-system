import { createHash } from 'node:crypto'
import { money, moneyString } from './money'
import type { StatementMovement, StatementReceivableLine } from './types'

export function buildCustomerStatement(input: {
  customerId: string
  currency: string
  periodStart: string
  periodEnd: string
  beginningBalance?: string | number
  receivables: StatementReceivableLine[]
  movements: StatementMovement[]
}) {
  let running = money(input.beginningBalance || 0)
  const lines = [
    ...input.receivables.map((line) => ({ date: line.date, kind: 'receivable' as const, reference: line.documentNo, debit: money(line.amount), credit: money(0) })),
    ...input.movements.filter((line) => line.status === 'approved').map((line) => {
      const isDebit = line.kind === 'refund'
      return { date: line.date, kind: line.kind, reference: line.reference, debit: isDebit ? money(line.amount) : money(0), credit: isDebit ? money(0) : money(line.amount) }
    }),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference))
    .map((line) => {
      running = running.plus(line.debit).minus(line.credit)
      return { ...line, debit: moneyString(line.debit), credit: moneyString(line.credit), balance: moneyString(running) }
    })
  const snapshot = { customerId: input.customerId, currency: input.currency, periodStart: input.periodStart, periodEnd: input.periodEnd, lines }
  return { ...snapshot, beginningBalance: moneyString(input.beginningBalance || 0), endingBalance: moneyString(running), sourceSnapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') }
}
