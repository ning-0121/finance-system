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

/** 默认应退税额 = 进项不含税额 × 退税率%（负值/非法输入按 0，避免算出负应退） */
export function computeRefundable(inputAmount: number, refundRate: number): number {
  const amt = Math.max(0, Number(inputAmount) || 0)
  const rate = Math.max(0, Number(refundRate) || 0)
  return r2(amt * rate / 100)
}

export async function getTaxRefunds(): Promise<TaxRefund[]> {
  const supabase = createClient()
  const { data, error } = await fetchAll<TaxRefund>((f, t) => supabase.from('tax_refunds').select('*').order('export_date', { ascending: false }).order('id', { ascending: true }).range(f, t))
  if (error) console.error('[tax-refund] getTaxRefunds:', error.message)
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
    // 部分更新：只提交调用方真正传入的字段。此前整行覆盖——"标记申报/到账"只传
    // {id,status,日期} 却把报关单号/品名/FOB/进项/单证勾选全部抹成缺省值(生产数据破坏)。
    const patch: Record<string, unknown> = { updated_at: row.updated_at }
    for (const k of Object.keys(row) as (keyof typeof row)[]) {
      if (k !== 'updated_at' && k in payload) patch[k] = row[k]
    }
    const { data: hit, error } = await supabase.from('tax_refunds').update(patch).eq('id', payload.id).select('id')
    if (error) return { error: error.message }
    // RLS 静默 0 行防线：非财务角色更新被过滤时不再假成功
    if (!hit || hit.length === 0) return { error: '更新未生效：记录不存在或当前角色无权限（需财务角色）' }
    return { error: null }
  }
  // 防重复登记：同一报关单号只允许一条退税记录（避免重复申报/重复退税）
  if (row.customs_no) {
    const { data: dup } = await supabase.from('tax_refunds').select('id').eq('customs_no', row.customs_no).limit(1)
    if (dup && dup.length > 0) return { error: `报关单号 ${row.customs_no} 已存在退税记录，不可重复登记` }
  }
  const { error } = await supabase.from('tax_refunds').insert({ ...row, created_by: userData?.user?.id || null })
  if (error && /tax_refunds_customs_no/.test(error.message)) return { error: `报关单号 ${row.customs_no} 已存在退税记录（唯一约束）` }
  return { error: error?.message || null }
}

export async function deleteTaxRefund(id: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { data: hit, error } = await supabase.from('tax_refunds').delete().eq('id', id).select('id')
  if (error) return { error: error.message }
  // RLS 静默 0 行防线：删除权限仅财务主管/管理员，被过滤时不再假成功
  if (!hit || hit.length === 0) return { error: '删除未生效：记录不存在或当前角色无权限（删除需财务主管/管理员）' }
  return { error: null }
}
