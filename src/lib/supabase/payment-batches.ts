// 周排款子系统 · 查询层
// 所有「写」都走 ②引擎层的原子 RPC(防重逻辑在 DB,应用层只负责调用与取数)。
import { createClient } from './client'
import { fetchAll } from './fetch-all'
import type { PayableRecord } from '@/lib/types'

export type BatchStatus = 'draft' | 'submitted' | 'approved' | 'executing' | 'closed' | 'cancelled'
export type BatchLineStatus = 'planned' | 'paid' | 'skipped' | 'held'

export interface PaymentBatch {
  id: string
  batch_no: string
  title: string | null
  currency: string
  week_label: string | null
  planned_pay_date: string | null
  status: BatchStatus
  total_amount: number
  paid_total: number
  notes: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface PaymentBatchLine {
  id: string
  batch_id: string
  payable_id: string
  supplier_name: string
  pay_amount: number
  currency: string
  payee_name: string | null
  payee_account: string | null
  payee_bank: string | null
  status: BatchLineStatus
  payment_id: string | null
  payment_ref: string | null
  payment_proof_path: string | null   // 付款凭证图片(finance-attachments 路径)
  executed_at: string | null
  executed_by: string | null
  notes: string | null
  created_at: string
}

// 应付 + 剩余可排(= amount - 已付 - 已排未关闭行)
export interface SchedulablePayable extends PayableRecord {
  reserved: number   // 已排(所有未关闭行)累计
  remaining: number  // 剩余可排
}

async function actorId(): Promise<string | null> {
  const supabase = createClient()
  const { data } = await supabase.auth.getUser()
  return data?.user?.id || null
}

export async function getAppRole(): Promise<string | null> {
  try {
    const supabase = createClient()
    const { data } = await supabase.rpc('_app_role')
    return (data as string) || null
  } catch { return null }
}

export async function getPaymentBatches(status?: BatchStatus): Promise<PaymentBatch[]> {
  try {
    const supabase = createClient()
    const { data } = await fetchAll<PaymentBatch>((from, to) => {
      let q = supabase.from('payment_batches').select('*').is('deleted_at', null)
        .order('created_at', { ascending: false }).order('id', { ascending: true })
      if (status) q = q.eq('status', status)
      return q.range(from, to)
    })
    return data || []
  } catch { return [] }
}

export async function getBatchLines(batchId: string): Promise<PaymentBatchLine[]> {
  try {
    const supabase = createClient()
    const { data } = await fetchAll<PaymentBatchLine>((from, to) =>
      supabase.from('payment_batch_lines').select('*').eq('batch_id', batchId).is('deleted_at', null)
        .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to))
    return data || []
  } catch { return [] }
}

// 可排应付：未付清/未取消 + 计算剩余可排(扣掉所有排款单里已排的额度),仅返回剩余>0
export async function getSchedulablePayables(currency?: string): Promise<SchedulablePayable[]> {
  try {
    const supabase = createClient()
    const { data: payables } = await fetchAll<PayableRecord>((from, to) => {
      let q = supabase.from('payable_records').select('*').is('deleted_at', null)
        .in('payment_status', ['unpaid', 'pending_approval', 'approved', 'partially_paid'])
        .order('due_date', { ascending: true }).order('id', { ascending: true })
      if (currency) q = q.eq('currency', currency)
      return q.range(from, to)
    })
    if (!payables || payables.length === 0) return []

    // 已排额度：所有未关闭行(planned/held/paid)按 payable 汇总
    const { data: lines } = await fetchAll<{ payable_id: string; pay_amount: number; status: string }>((from, to) =>
      supabase.from('payment_batch_lines').select('payable_id, pay_amount, status').is('deleted_at', null)
        .in('status', ['planned', 'held', 'paid']).range(from, to))
    const reservedMap = new Map<string, number>()
    for (const l of lines || []) {
      reservedMap.set(l.payable_id, (reservedMap.get(l.payable_id) || 0) + Number(l.pay_amount || 0))
    }

    const out: SchedulablePayable[] = []
    for (const p of payables) {
      const reserved = reservedMap.get(p.id) || 0
      const remaining = Number(p.amount) - Number(p.paid_amount || 0) - reserved
      if (remaining > 0.005) out.push({ ...p, reserved, remaining: Math.round(remaining * 100) / 100 })
    }
    return out
  } catch { return [] }
}

type RpcResult = { data: Record<string, unknown> | null; error: string | null }

async function callRpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { data: null, error: friendly(error.message) }
    return { data: (data as Record<string, unknown>) || null, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : '未知错误' }
  }
}

// RPC 的 RAISE EXCEPTION 文案已是中文,这里剥掉 Postgres 前缀,保留冒号后的业务文案
function friendly(msg: string): string {
  const m = msg.match(/[A-Z_]+:\s*(.+)$/)
  return m ? m[1] : msg
}

export async function createPaymentBatch(p: {
  currency: string; planned_pay_date?: string | null; title?: string | null; notes?: string | null
}): Promise<RpcResult> {
  return callRpc('create_payment_batch', {
    p_actor: await actorId(), p_currency: p.currency,
    p_planned_pay_date: p.planned_pay_date || null, p_title: p.title || null,
    p_week_label: null, p_notes: p.notes || null,
  })
}

export async function addBatchLine(batchId: string, payableId: string, payAmount: number | null): Promise<RpcResult> {
  return callRpc('add_payment_batch_line', {
    p_batch_id: batchId, p_payable_id: payableId, p_pay_amount: payAmount, p_actor: await actorId(),
  })
}

export async function removeBatchLine(lineId: string, reason?: string): Promise<RpcResult> {
  return callRpc('remove_payment_batch_line', { p_line_id: lineId, p_actor: await actorId(), p_reason: reason || null })
}

export async function submitBatch(batchId: string): Promise<RpcResult> {
  return callRpc('submit_payment_batch', { p_batch_id: batchId, p_actor: await actorId() })
}

export async function approveBatch(batchId: string): Promise<RpcResult> {
  return callRpc('approve_payment_batch', { p_batch_id: batchId, p_actor: await actorId() })
}

export async function executeBatchLine(lineId: string, p: {
  payment_ref: string; paid_at?: string | null; note?: string | null
}): Promise<RpcResult> {
  return callRpc('execute_batch_line_payment', {
    p_line_id: lineId, p_actor: await actorId(),
    p_payment_ref: p.payment_ref, p_paid_at: p.paid_at || null, p_note: p.note || null,
  })
}

/** 附加/补传付款凭证图片(finance-attachments 路径)到已付排款行。 */
export async function setBatchLinePaymentProof(lineId: string, proofPath: string): Promise<RpcResult> {
  return callRpc('set_batch_line_payment_proof', {
    p_line_id: lineId, p_actor: await actorId(), p_proof_path: proofPath,
  })
}

export async function closeBatch(batchId: string): Promise<RpcResult> {
  return callRpc('close_payment_batch', { p_batch_id: batchId, p_actor: await actorId() })
}

export async function cancelBatch(batchId: string, reason?: string): Promise<RpcResult> {
  return callRpc('cancel_payment_batch', { p_batch_id: batchId, p_actor: await actorId(), p_reason: reason || null })
}
