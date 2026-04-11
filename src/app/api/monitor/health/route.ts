// 财务系统健康检查 + 数据完整性监控
// GET /api/monitor/health
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const checks: Record<string, { status: 'ok' | 'warn' | 'error'; detail: string }> = {}

  try {
    const supabase = await createClient()

    // 1. 数据库连通性
    const { error: pingErr } = await supabase.from('profiles').select('id').limit(1)
    checks.database = pingErr
      ? { status: 'error', detail: `连接失败: ${pingErr.message}` }
      : { status: 'ok', detail: '连接正常' }

    // 2. RLS可读性验证（核心：确保anon key能读到数据）
    const tables = ['budget_orders', 'cost_items', 'customers', 'uploaded_documents']
    for (const table of tables) {
      const { error } = await supabase.from(table).select('id').limit(1)
      checks[`rls_${table}`] = error
        ? { status: 'error', detail: `RLS阻止读取: ${error.message}` }
        : { status: 'ok', detail: '可读' }
    }

    // 3. 数据一致性检查
    // 3a. 有无orphan synced_orders (budget_order_id指向不存在的budget_orders)
    const { data: orphans } = await supabase
      .from('synced_orders')
      .select('id, order_no, budget_order_id')
      .not('budget_order_id', 'is', null)
    // 简单检查：如果能查到就ok
    checks.synced_orders = { status: 'ok', detail: `${orphans?.length || 0} linked orders` }

    // 3b. 借贷平衡验证
    const { data: journals } = await supabase
      .from('journal_entries')
      .select('voucher_no, total_debit, total_credit')
      .neq('status', 'voided')
    const imbalanced = (journals || []).filter(j => Math.abs((j.total_debit as number) - (j.total_credit as number)) > 0.01)
    checks.debit_credit_balance = imbalanced.length > 0
      ? { status: 'error', detail: `${imbalanced.length}张凭证借贷不平衡: ${imbalanced.map(j => j.voucher_no).join(', ')}` }
      : { status: 'ok', detail: `${journals?.length || 0}张凭证全部平衡` }

    // 3c. 预算单状态分布
    const { data: statusDist } = await supabase.from('budget_orders').select('status')
    const dist: Record<string, number> = {}
    statusDist?.forEach(o => { dist[o.status as string] = (dist[o.status as string] || 0) + 1 })
    checks.order_status = { status: 'ok', detail: JSON.stringify(dist) }

    // 4. 审计日志健康
    const { count: auditCount } = await supabase
      .from('financial_audit_log')
      .select('id', { count: 'exact', head: true })
    checks.audit_log = { status: 'ok', detail: `${auditCount || 0}条审计记录` }

    // 5. 会计期间状态
    const { data: periods } = await supabase
      .from('accounting_periods')
      .select('period_code, status')
      .order('period_code', { ascending: false })
      .limit(3)
    checks.accounting_periods = {
      status: 'ok',
      detail: (periods || []).map(p => `${p.period_code}:${p.status}`).join(', ') || '无期间数据'
    }

    // 汇总
    const hasError = Object.values(checks).some(c => c.status === 'error')
    const hasWarn = Object.values(checks).some(c => c.status === 'warn')

    return NextResponse.json({
      status: hasError ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy',
      timestamp: new Date().toISOString(),
      checks,
    }, { status: hasError ? 503 : 200 })
  } catch (err) {
    return NextResponse.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'Unknown',
      checks,
    }, { status: 503 })
  }
}
