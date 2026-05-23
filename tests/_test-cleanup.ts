/**
 * Wave 1-A · 测试 cleanup 工具
 *
 * 财务表挂了 trg_no_hard_delete trigger，普通 `.delete()` 被拒绝。
 * 测试/迁移必须用 _admin_hard_delete RPC（SECURITY DEFINER + service_role only）绕过。
 *
 * 用法：
 *   import { hardDeleteForTest, cleanupTracked } from './_test-cleanup'
 *   await hardDeleteForTest(svc, 'budget_orders', orderId, 'e2e cleanup')
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const FINANCIAL_PROTECTED_TABLES = new Set([
  'actual_invoices',
  'payable_records',
  'order_settlements',
  'budget_orders',
  'shipping_documents',
  'financial_risk_events',
  'cost_items',
  'journal_entries',
  'journal_lines',
])

/**
 * 测试专用硬删除。财务表 → _admin_hard_delete RPC；其他表 → 直 .delete()。
 */
export async function hardDeleteForTest(
  svc: SupabaseClient,
  table: string,
  id: string,
  reason: string = 'test cleanup',
): Promise<{ deleted: boolean; rows: number; error?: string }> {
  if (FINANCIAL_PROTECTED_TABLES.has(table)) {
    const { data, error } = await svc.rpc('_admin_hard_delete' as never, {
      p_table: table, p_id: id, p_reason: reason,
    } as never)
    if (error) return { deleted: false, rows: 0, error: error.message }
    const rows = (data as { deleted_rows: number } | null)?.deleted_rows ?? 0
    return { deleted: rows > 0, rows }
  }
  const { error, count } = await svc.from(table).delete({ count: 'exact' }).eq('id', id)
  if (error) return { deleted: false, rows: 0, error: error.message }
  return { deleted: (count ?? 0) > 0, rows: count ?? 0 }
}

/**
 * 批量 cleanup：逆序执行。返回成功数 + 失败明细。
 */
export async function cleanupTracked(
  svc: SupabaseClient,
  records: Array<{ table: string; id: string }>,
  reason: string = 'test cleanup',
): Promise<{ cleaned: number; failures: Array<{ table: string; id: string; error: string }> }> {
  let cleaned = 0
  const failures: Array<{ table: string; id: string; error: string }> = []
  for (const { table, id } of [...records].reverse()) {
    const r = await hardDeleteForTest(svc, table, id, reason)
    if (r.deleted) cleaned++
    else if (r.error) failures.push({ table, id, error: r.error })
  }
  return { cleaned, failures }
}
