// ============================================================
// 工资条（客户端）— 花名册读取 + 导入批次 + 批次/工资条查询
// 发放(企业微信)走服务端 /api/payroll（需 access token）。
// ============================================================
import { createClient } from './client'

export interface Employee { id: string; name: string; wecom_userid: string | null; department: string | null }
export interface PayrollBatch { id: string; period_code: string; title: string; status: 'draft' | 'sent'; slip_count: number; sent_count: number; total_net: number; created_at: string }
export interface PayrollSlip {
  id: string; batch_id: string; employee_name: string; wecom_userid: string | null
  net_pay: number; items: { label: string; amount: number }[]
  send_status: 'pending' | 'sent' | 'failed' | 'skipped'; sent_at: string | null; send_error: string | null
}

const DEDUCT_KW = ['扣', '社保', '个税', '公积金', '代扣', '请假', '迟到']
const r2 = (n: number) => Math.round(n * 100) / 100
export const norm = (s: string) => (s || '').replace(/\s+/g, '').trim()

export async function getEmployees(): Promise<Employee[]> {
  const supabase = createClient()
  const { data } = await supabase.from('employees').select('id, name, wecom_userid, department').eq('active', true).order('name')
  return (data || []) as Employee[]
}

export async function getBatches(): Promise<PayrollBatch[]> {
  const supabase = createClient()
  const { data } = await supabase.from('payroll_batches').select('*').order('created_at', { ascending: false }).limit(50)
  return (data || []) as PayrollBatch[]
}

export async function getSlips(batchId: string): Promise<PayrollSlip[]> {
  const supabase = createClient()
  const { data } = await supabase.from('payroll_slips').select('*').eq('batch_id', batchId).order('employee_name')
  return (data || []) as PayrollSlip[]
}

/** 把一项金额按表头判定是应发(正)还是扣减(负) */
export function signedAmount(header: string, value: number): number {
  if (value < 0) return r2(value)
  return DEDUCT_KW.some(k => header.includes(k)) ? r2(-Math.abs(value)) : r2(value)
}

/**
 * 导入工资表：rows 已解析为 {name, netPay, items}。
 * 按姓名匹配花名册补 wecom_userid（重名/未建档则 userid 空，发放时跳过并提示）。
 */
export async function importPayrollBatch(
  periodCode: string, title: string,
  rows: { name: string; netPay: number; items: { label: string; amount: number }[] }[],
): Promise<{ batchId: string | null; matched: number; unmatched: number; error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const employees = await getEmployees()
  const byName = new Map<string, Employee[]>()
  for (const e of employees) {
    const k = norm(e.name)
    if (!byName.has(k)) byName.set(k, [])
    byName.get(k)!.push(e)
  }
  const totalNet = r2(rows.reduce((s, r) => s + (Number(r.netPay) || 0), 0))
  const { data: batch, error: bErr } = await supabase.from('payroll_batches').insert({
    period_code: periodCode, title, status: 'draft', slip_count: rows.length, total_net: totalNet, created_by: userData?.user?.id || null,
  }).select('id').single()
  if (bErr || !batch) return { batchId: null, matched: 0, unmatched: 0, error: bErr?.message || '创建批次失败' }

  let matched = 0, unmatched = 0
  const slipRows = rows.map(r => {
    const cands = byName.get(norm(r.name)) || []
    const uid = cands.length === 1 ? cands[0].wecom_userid : null  // 唯一匹配才自动绑定，重名不猜
    if (uid) matched++; else unmatched++
    return {
      batch_id: batch.id, employee_name: r.name, wecom_userid: uid,
      net_pay: r2(r.netPay), items: r.items,
      send_status: uid ? 'pending' : 'skipped',
      send_error: uid ? null : (cands.length > 1 ? '花名册重名，需手工指定' : '花名册无此人，请先同步通讯录'),
    }
  })
  const { error: sErr } = await supabase.from('payroll_slips').insert(slipRows)
  if (sErr) return { batchId: batch.id, matched, unmatched, error: sErr.message }
  return { batchId: batch.id, matched, unmatched, error: null }
}
