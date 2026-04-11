// 外汇损益核算模块
// 外贸服装公司核心场景：USD收入 → 结汇CNY → 与预算汇率比较 → 产生汇兑损益
import { createClient } from '@/lib/supabase/client'

interface FxGainResult {
  orderId: string
  orderNo: string
  budgetRate: number      // 预算汇率
  actualRate: number      // 实际结汇汇率
  revenueUsd: number      // USD收入
  budgetRevenueCny: number // 预算CNY收入 = USD × 预算汇率
  actualRevenueCny: number // 实际CNY收入 = USD × 实际汇率
  fxGainLoss: number      // 汇兑损益 = 实际 - 预算（正=收益 负=损失）
  isGain: boolean
}

/**
 * 计算单个订单的汇兑损益
 * 场景：订单预算时汇率6.9，实际结汇时汇率7.1 → 收益
 */
export function calculateFxGainLoss(
  revenueUsd: number,
  budgetRate: number,
  actualRate: number
): { gainLoss: number; isGain: boolean } {
  if (revenueUsd <= 0 || budgetRate <= 0 || actualRate <= 0) {
    return { gainLoss: 0, isGain: true }
  }
  const budgetCny = revenueUsd * budgetRate
  const actualCny = revenueUsd * actualRate
  const gainLoss = Math.round((actualCny - budgetCny) * 100) / 100
  return { gainLoss, isGain: gainLoss >= 0 }
}

/**
 * 批量计算所有USD订单的汇兑损益
 * 需要传入实际结汇汇率（从银行获取或手动输入）
 */
export async function calculateAllFxGains(actualRate: number): Promise<FxGainResult[]> {
  const supabase = createClient()
  const { data: orders } = await supabase
    .from('budget_orders')
    .select('id, order_no, total_revenue, exchange_rate, currency')
    .eq('currency', 'USD')
    .in('status', ['approved', 'closed'])

  if (!orders?.length) return []

  return orders.map(o => {
    const budgetRate = (o.exchange_rate as number) || 7
    const revenueUsd = (o.total_revenue as number) || 0
    const { gainLoss, isGain } = calculateFxGainLoss(revenueUsd, budgetRate, actualRate)

    return {
      orderId: o.id as string,
      orderNo: o.order_no as string,
      budgetRate,
      actualRate,
      revenueUsd,
      budgetRevenueCny: Math.round(revenueUsd * budgetRate * 100) / 100,
      actualRevenueCny: Math.round(revenueUsd * actualRate * 100) / 100,
      fxGainLoss: gainLoss,
      isGain,
    }
  })
}

/**
 * 生成汇兑损益凭证
 * 收益: 借:应收外汇/银行存款 贷:汇兑收益
 * 损失: 借:汇兑损失 贷:应收外汇/银行存款
 */
export async function postFxGainLossJournal(
  gains: FxGainResult[],
  periodCode: string
): Promise<{ voucherNo: string; totalGain: number; totalLoss: number }> {
  const supabase = createClient()
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
  const createdBy = profiles?.[0]?.id

  const totalGain = gains.filter(g => g.isGain).reduce((s, g) => s + g.fxGainLoss, 0)
  const totalLoss = gains.filter(g => !g.isGain).reduce((s, g) => s + Math.abs(g.fxGainLoss), 0)
  const netGainLoss = totalGain - totalLoss

  if (Math.abs(netGainLoss) < 0.01) {
    return { voucherNo: '', totalGain: 0, totalLoss: 0 }
  }

  const lines: { account_code: string; description: string; debit: number; credit: number }[] = []

  if (netGainLoss > 0) {
    // 净收益
    lines.push({ account_code: '100201', description: '结汇收益-银行', debit: netGainLoss, credit: 0 })
    lines.push({ account_code: '5301', description: '汇兑收益', debit: 0, credit: netGainLoss })
  } else {
    // 净损失
    lines.push({ account_code: '5601', description: '汇兑损失', debit: Math.abs(netGainLoss), credit: 0 })
    lines.push({ account_code: '100201', description: '结汇损失-银行', debit: 0, credit: Math.abs(netGainLoss) })
  }

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0)

  const { data: journal, error } = await supabase
    .from('journal_entries')
    .insert({
      voucher_no: '',
      period_code: periodCode,
      voucher_date: new Date().toISOString().substring(0, 10),
      voucher_type: 'closing',
      description: `期末汇兑损益结转 实际汇率${gains[0]?.actualRate || '-'}`,
      source_type: 'fx_revaluation',
      total_debit: Math.round(totalDebit * 100) / 100,
      total_credit: Math.round(totalCredit * 100) / 100,
      status: 'posted',
      created_by: createdBy,
      posted_by: createdBy,
      posted_at: new Date().toISOString(),
    })
    .select('id, voucher_no')
    .single()

  if (error) throw new Error(`汇兑凭证创建失败: ${error.message}`)

  await supabase.from('journal_lines').insert(
    lines.map((l, i) => ({
      journal_id: journal.id,
      line_no: i + 1,
      account_code: l.account_code,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    }))
  )

  return { voucherNo: journal.voucher_no, totalGain, totalLoss }
}
