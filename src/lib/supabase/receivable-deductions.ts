/**
 * 客户扣款读写(2026-08-05)。
 * ⚠️ 治理:写入走登录会话(RLS 限财务角色),created_by 记真实 auth.uid(),
 *    绝不接受调用方传入的 actor —— 与本系统其他财务写入同规矩。
 */
import { createClient } from './client'
import { fetchAll } from './fetch-all'
import type { DeductionRow, DeductionType, Treatment } from '@/lib/financial/receivable-deduction'

export async function getDeductionsByOrders(orderIds: string[]): Promise<Record<string, DeductionRow[]>> {
  const out: Record<string, DeductionRow[]> = {}
  if (!orderIds.length) return out
  const sb = createClient()
  // 分批 in():订单数可能上千,单次 in 过长会被 URL 长度限制截断
  for (let i = 0; i < orderIds.length; i += 200) {
    const slice = orderIds.slice(i, i + 200)
    const { data, error } = await sb.from('receivable_deductions')
      .select('id, budget_order_id, amount_original, currency, exchange_rate, amount_cny, deduction_type, treatment, reason, occurred_at, voided_at')
      .in('budget_order_id', slice).is('voided_at', null)
    if (error) { console.error('[deductions] 读取失败:', error.message); continue }
    for (const r of (data || []) as DeductionRow[]) (out[r.budget_order_id] ??= []).push(r)
  }
  return out
}

export async function getAllDeductions(): Promise<DeductionRow[]> {
  const sb = createClient()
  const { data } = await fetchAll<DeductionRow>((from, to) => sb.from('receivable_deductions')
    .select('id, budget_order_id, amount_original, currency, exchange_rate, amount_cny, deduction_type, treatment, reason, occurred_at, voided_at')
    .is('voided_at', null).order('occurred_at', { ascending: false }).order('id').range(from, to))
  return data || []
}

export async function createDeduction(p: {
  budget_order_id: string
  customer_id?: string | null
  customer_name?: string | null
  amount_original: number
  currency: string
  exchange_rate: number
  amount_cny: number
  deduction_type: DeductionType
  treatment: Treatment
  reason: string
  occurred_at: string
  notes?: string | null
}): Promise<{ error: string | null; id?: string }> {
  try {
    const sb = createClient()
    const { data: u } = await sb.auth.getUser()
    if (!u?.user?.id) return { error: '请先登录后再登记扣款（需记录真实操作人）' }
    const { data, error } = await sb.from('receivable_deductions')
      .insert({ ...p, created_by: u.user.id }).select('id').single()
    if (error) return { error: error.message }
    return { error: null, id: data.id as string }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '未知错误' }
  }
}

/** 作废扣款(软删,必须写原因) */
export async function voidDeduction(id: string, reason: string): Promise<{ error: string | null }> {
  if (!reason.trim()) return { error: '请填写作废原因' }
  try {
    const sb = createClient()
    const { data: u } = await sb.auth.getUser()
    if (!u?.user?.id) return { error: '请先登录' }
    const { error } = await sb.from('receivable_deductions')
      .update({ voided_at: new Date().toISOString(), voided_by: u.user.id, void_reason: reason.trim() })
      .eq('id', id).is('voided_at', null)
    return { error: error?.message ?? null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '未知错误' }
  }
}
