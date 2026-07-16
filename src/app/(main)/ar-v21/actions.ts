'use server'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { arFlags } from '@/lib/ar-v21/feature-flags'
import { parseBankStatement } from '@/lib/ar-v21/bank-import'

const accountIdSchema = z.string().uuid()

async function requireFinance(roles: string[]) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!roles.includes(String(profile?.role || 'viewer'))) throw new Error('FORBIDDEN')
  return { supabase, userId: user.id }
}

function fileFrom(formData: FormData) {
  const file = formData.get('file')
  if (!(file instanceof File)) throw new Error('BANK_FILE_REQUIRED')
  return file
}

export async function previewBankStatement(formData: FormData) {
  if (!arFlags.bankImport()) return { ok: false as const, error: 'AR_V21_BANK_IMPORT_DISABLED' }
  await requireFinance(['finance_staff','finance_manager','admin'])
  try {
    const accountId = accountIdSchema.parse(formData.get('bankAccountId'))
    const file = fileFrom(formData)
    const parsed = parseBankStatement(new Uint8Array(await file.arrayBuffer()), file.name, accountId)
    return { ok: true as const, ...parsed, rows: parsed.rows.slice(0, 200), totalRows: parsed.rows.length }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'BANK_PREVIEW_FAILED' }
  }
}

export async function confirmBankStatementImport(formData: FormData) {
  if (!arFlags.bankImport()) return { ok: false as const, error: 'AR_V21_BANK_IMPORT_DISABLED' }
  const { supabase, userId } = await requireFinance(['finance_staff','finance_manager','admin'])
  try {
    if (formData.get('confirmed') !== 'true') throw new Error('HUMAN_CONFIRMATION_REQUIRED')
    const accountId = accountIdSchema.parse(formData.get('bankAccountId'))
    const file = fileFrom(formData)
    const parsed = parseBankStatement(new Uint8Array(await file.arrayBuffer()), file.name, accountId)
    if (parsed.errors.length) throw new Error('IMPORT_HAS_ROW_ERRORS')
    const idempotencyKey = createHash('sha256').update(`${accountId}|${parsed.checksum}|${userId}`).digest('hex')
    const { data, error } = await supabase.rpc('commit_ar_bank_import', {
      p_bank_account_id: accountId,
      p_source_filename: file.name,
      p_file_checksum: parsed.checksum,
      p_file_type: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx',
      p_parser_version: 'ar-v21-deterministic-1',
      p_idempotency_key: idempotencyKey,
      p_rows: parsed.rows,
    })
    if (error) throw new Error(error.message)
    return { ok: true as const, result: data }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'BANK_IMPORT_FAILED' }
  }
}
