// ============================================================
// 出口退税台账（客户端）
// 应退税额 = 采购增值税专票不含税额 × 退税率（默认值，可手工覆盖）。
// ============================================================
import { createClient } from './client'
import { fetchAll } from './fetch-all'

export interface TaxRefund {
  id: string
  budget_order_id: string | null
  customs_no: string | null
  export_date: string | null
  product_name: string | null
  fob_usd: number | null
  exchange_rate: number | null
  fob_cny: number | null
  input_invoice_amount: number
  refund_rate: number
  refundable_amount: number
  doc_customs: boolean
  doc_invoice: boolean
  doc_forex: boolean
  status: 'pending' | 'declared' | 'refunded'
  declared_at: string | null
  refund_received_amount: number | null
  refund_received_at: string | null
  notes: string | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** 默认应退税额 = 进项不含税额 × 退税率% */
export function computeRefundable(inputAmount: number, refundRate: number): number {
  return r2((Number(inputAmount) || 0) * (Number(refundRate) || 0) / 100)
}

export async function getTaxRefunds(): Promise<TaxRefund[]> {
  const supabase = createClient()
  const { data } = await fetchAll<TaxRefund>((f, t) => supabase.from('tax_refunds').select('*').order('export_date', { ascending: false }).order('id', { ascending: true }).range(f, t))
  return (data || []) as TaxRefund[]
}

export async function saveTaxRefund(payload: Partial<TaxRefund> & { id?: string }): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const row = {
    budget_order_id: payload.budget_order_id || null,
    customs_no: payload.customs_no?.trim() || null,
    export_date: payload.export_date || null,
    product_name: payload.product_name?.trim() || null,
    fob_usd: payload.fob_usd ?? null,
    exchange_rate: payload.exchange_rate ?? null,
    fob_cny: payload.fob_cny ?? null,
    input_invoice_amount: payload.input_invoice_amount ?? 0,
    refund_rate: payload.refund_rate ?? 13,
    refundable_amount: payload.refundable_amount ?? 0,
    doc_customs: !!payload.doc_customs,
    doc_invoice: !!payload.doc_invoice,
    doc_forex: !!payload.doc_forex,
    status: payload.status || 'pending',
    declared_at: payload.declared_at || null,
    refund_received_amount: payload.refund_received_amount ?? null,
    refund_received_at: payload.refund_received_at || null,
    notes: payload.notes?.trim() || null,
    updated_at: new Date().toISOString(),
  }
  if (payload.id) {
    const { error } = await supabase.from('tax_refunds').update(row).eq('id', payload.id)
    return { error: error?.message || null }
  }
  const { error } = await supabase.from('tax_refunds').insert({ ...row, created_by: userData?.user?.id || null })
  return { error: error?.message || null }
}

export async function deleteTaxRefund(id: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { error } = await supabase.from('tax_refunds').delete().eq('id', id)
  return { error: error?.message || null }
}
