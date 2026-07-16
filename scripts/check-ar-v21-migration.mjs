import { readFileSync } from 'node:fs'

const file = new URL('../migrations/20260716_ar_v21_reconciliation.sql', import.meta.url)
const sql = readFileSync(file, 'utf8')
const executableSql = sql.replace(/--.*$/gm, '')
const failures = []

for (const [label, pattern] of [
  ['DROP TABLE/COLUMN/CONSTRAINT', /\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT)\b/i],
  ['DELETE FROM', /\bDELETE\s+FROM\b/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
]) if (pattern.test(executableSql)) failures.push(label)

for (const required of [
  'bank_statement_imports', 'normalized_fingerprint', 'ar_adjustments',
  'cash_application_batches', 'receipt_difference_treatments', 'customer_statements',
  'auth.uid()', 'approve_ar_allocation', 'reverse_ar_allocation', 'commit_ar_bank_import',
]) if (!sql.includes(required)) failures.push(`missing ${required}`)

if (failures.length) {
  console.error(`AR V2.1 migration safety failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('AR V2.1 migration safety: additive DDL and controlled RPC checks passed')
