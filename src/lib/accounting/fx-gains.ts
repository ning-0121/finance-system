// 外汇损益核算模块
// 外贸服装公司核心场景：USD收入 → 结汇CNY → 与预算汇率比较 → 产生汇兑损益
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { safeRate, sumAmounts, mulAmount } from './utils'
import { bizToday } from '@/lib/biz-date'

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
  const budgetCny = mulAmount(revenueUsd, budgetRate)
  const actualCny = mulAmount(revenueUsd, actualRate)
  const gainLoss = mulAmount(actualCny - budgetCny, 1)
  return { gainLoss, isGain: gainLoss >= 0 }
}

/**
 * 批量计算所有USD订单的汇兑损益
 * 需要传入实际结汇汇率（从银行获取或手动输入）
 */
export async function calculateAllFxGains(actualRate: number): Promise<FxGainResult[]> {
  const supabase = createClient()
  const { data: orders } = await fetchAll<Record<string, unknown>>((f, t) => supabase
    .from('budget_orders')
    .select('id, order_no, total_revenue, exchange_rate, currency')
    .eq('currency', 'USD')
    .in('status', ['approved', 'closed']).order('id', { ascending: true }).range(f, t))

  if (!orders?.length) return []

  return orders.map(o => {
    const budgetRate = safeRate(o.exchange_rate as number, 'USD', `fx-gains order ${o.id}`)
    const revenueUsd = (o.total_revenue as number) || 0
    const { gainLoss, isGain } = calculateFxGainLoss(revenueUsd, budgetRate, actualRate)

    return {
      orderId: o.id as string,
      orderNo: o.order_no as string,
      budgetRate,
      actualRate,
      revenueUsd,
      budgetRevenueCny: mulAmount(revenueUsd, budgetRate),
      actualRevenueCny: mulAmount(revenueUsd, actualRate),
      fxGainLoss: gainLoss,
      isGain,
    }
  })
}

/**
 * 期末汇兑损益重估 → 生成「受控灰度草稿凭证」（不自动过账）。
 *
 * 审计修复 C4 已接入受控灰度：
 *   - 走原子 RPC create_journal_draft（header+lines 同事务，杜绝孤立凭证）；
 *   - 仅生成 status='draft' + requires_review=true，进 GL 复核中心等人工过账，
 *     过账时由 post_journal 累加 gl_balances（试算平衡可见）；
 *   - 带完整 provenance（business_event='fx_revaluation' + 说明 + 汇率来源）；
 *   - 幂等：同会计期间已有 fx_revaluation 草稿/已过账则跳过。
 *
 * 重估的对账户是 **应收账款 1122**（外币货币性资产随汇率变动增减），不是银行——
 * 此时尚未结汇收款，银行余额不应变动。
 *   收益（期末汇率>入账汇率）: 借 应收账款1122 / 贷 汇兑收益5301
 *   损失（期末汇率<入账汇率）: 借 汇兑损失5601 / 贷 应收账款1122
 */
export async function createFxRevaluationDraft(
  gains: FxGainResult[],
  periodCode: string,
  asOfDate?: string,
): Promise<{ created: boolean; reason?: string; journalId?: string; voucherNo?: string; net: number }> {
  const supabase = createClient()
  // 草稿创建人必须是真实登录人（防审计归属伪造）；月结由财务在界面触发，必有会话
  const { data: userData } = await supabase.auth.getUser()
  const createdBy = userData?.user?.id ?? null
  if (!createdBy) {
    return { created: false, reason: '无法确定操作者（未登录），未生成重估草稿', net: 0 }
  }

  const totalGain = sumAmounts(gains.filter(g => g.isGain).map(g => g.fxGainLoss))
  const totalLoss = sumAmounts(gains.filter(g => !g.isGain).map(g => Math.abs(g.fxGainLoss)))
  const net = mulAmount(totalGain - totalLoss, 1)
  if (Math.abs(net) < 0.01) return { created: false, reason: '净汇兑损益≈0，无需入账', net }

  // 幂等：同期间已有汇兑重估草稿/已过账 → 跳过
  const { data: existing } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('source_type', 'fx_revaluation')
    .eq('period_code', periodCode)
    .in('status', ['draft', 'posted'])
    .limit(1)
  if (existing && existing.length > 0) return { created: false, reason: '该期间汇兑重估草稿已存在', net }

  const lines = net > 0
    ? [
        { account_code: '1122', description: '应收账款汇兑重估(收益)', debit: net, credit: 0 },
        { account_code: '5301', description: '汇兑收益', debit: 0, credit: net },
      ]
    : [
        { account_code: '5601', description: '汇兑损失', debit: Math.abs(net), credit: 0 },
        { account_code: '1122', description: '应收账款汇兑重估(损失)', debit: 0, credit: Math.abs(net) },
      ]
  const totalDebit = sumAmounts(lines.map(l => l.debit))
  const totalCredit = sumAmounts(lines.map(l => l.credit))
  const linesJson = lines.map((l, i) => ({
    line_no: i + 1, account_code: l.account_code, description: l.description,
    debit: Math.round(l.debit * 100) / 100, credit: Math.round(l.credit * 100) / 100,
    currency: 'CNY', exchange_rate: 1, original_amount: null,
    customer_id: null, supplier_name: null, order_id: null,
  }))
  const actualRate = gains[0]?.actualRate

  const { data, error } = await supabase.rpc('create_journal_draft', {
    p_period_code: periodCode,
    p_date: asOfDate ?? bizToday(),
    p_description: `期末汇兑损益重估 ${periodCode} 实际汇率${actualRate ?? '-'}`,
    p_source_type: 'fx_revaluation',
    p_source_id: crypto.randomUUID(), // 期末重估无单一源单据，用合成 id 满足 provenance 非空
    p_total_debit: Math.round(totalDebit * 100) / 100,
    p_total_credit: Math.round(totalCredit * 100) / 100,
    p_created_by: createdBy,
    p_lines: linesJson,
    p_business_event: 'fx_revaluation',
    p_target_journal_type: 'fx_revaluation',
    p_exchange_rate_source: `actual_rate=${actualRate ?? '-'}`,
    p_explanation: `期末对未结汇外币应收按汇率 ${actualRate} 重估：收益¥${totalGain} 损失¥${totalLoss} 净¥${net}`,
    p_requires_review: true,
  })
  if (error) return { created: false, reason: error.message, net }
  const r = data as { journal_id: string; voucher_no: string }
  return { created: true, journalId: r.journal_id, voucherNo: r.voucher_no, net }
}
