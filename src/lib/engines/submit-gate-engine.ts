// AI智能纠错引擎 — 提交前全域核查
// 跨表校验、数据完整性、逻辑合理性，有问题立即拦截
import { createClient } from '@/lib/supabase/client'

export interface GateCheck {
  name: string
  status: 'passed' | 'warning' | 'error'
  message: string
  suggestion?: string
}

export interface GateResult {
  canSubmit: boolean
  errors: GateCheck[]
  warnings: GateCheck[]
  passed: GateCheck[]
  summary: string
}

function buildResult(checks: GateCheck[]): GateResult {
  const errors = checks.filter(c => c.status === 'error')
  const warnings = checks.filter(c => c.status === 'warning')
  const passed = checks.filter(c => c.status === 'passed')
  return {
    canSubmit: errors.length === 0,
    errors, warnings, passed,
    summary: `${passed.length}项通过，${warnings.length}项警告，${errors.length}项错误`,
  }
}

// ========== 订单提交审批前全域核查 ==========

export async function runOrderSubmitGate(orderId: string): Promise<GateResult> {
  const supabase = createClient()
  const checks: GateCheck[] = []

  // 加载订单数据
  const { data: order } = await supabase
    .from('budget_orders')
    .select('*, customers(company, country, currency)')
    .eq('id', orderId)
    .single()

  if (!order) {
    return buildResult([{ name: '订单存在', status: 'error', message: '订单不存在', suggestion: '请刷新页面' }])
  }

  const revenue = (order.total_revenue as number) || 0
  const cost = (order.total_cost as number) || 0
  const profit = (order.estimated_profit as number) || 0
  const margin = (order.estimated_margin as number) || 0
  const rate = (order.exchange_rate as number) || 1
  const currency = order.currency as string
  const customer = order.customers as Record<string, unknown> | null

  // --- 1. 订单完整性 ---
  if (revenue <= 0) {
    checks.push({ name: '合同金额', status: 'error', message: '合同金额为0，请先填写合同金额', suggestion: '点击编辑填写' })
  } else {
    checks.push({ name: '合同金额', status: 'passed', message: `${currency === 'CNY' ? '¥' : '$'}${revenue.toLocaleString()}` })
  }

  if (cost <= 0) {
    checks.push({ name: '成本预算', status: 'error', message: '成本预算为0，请先填写成本明细', suggestion: '点击编辑填写面料/辅料/加工费等' })
  } else {
    checks.push({ name: '成本预算', status: 'passed', message: `¥${cost.toLocaleString()}` })
  }

  // --- 2. 汇率合理性 ---
  if (currency === 'CNY' && rate !== 1) {
    checks.push({ name: '汇率', status: 'error', message: `人民币汇率应为1，当前${rate}`, suggestion: '修改汇率为1' })
  } else if (currency === 'USD' && (rate < 5 || rate > 9)) {
    checks.push({ name: '汇率', status: 'warning', message: `美元汇率${rate}不在正常范围(5-9)`, suggestion: '当前约6.9-7.2' })
  } else {
    checks.push({ name: '汇率', status: 'passed', message: `${currency} 汇率${rate}` })
  }

  // --- 3. 利润合理性 ---
  if (revenue > 0 && cost > 0) {
    if (margin < 0) {
      checks.push({ name: '利润率', status: 'error', message: `订单亏损！利润¥${profit.toLocaleString()}，毛利率${margin}%`, suggestion: '请检查成本是否正确' })
    } else if (margin < 5) {
      checks.push({ name: '利润率', status: 'warning', message: `毛利率仅${margin}%，低于5%警戒线`, suggestion: '建议与客户协商价格或降低成本' })
    } else if (margin > 60) {
      checks.push({ name: '利润率', status: 'warning', message: `毛利率${margin}%异常偏高，请核实成本`, suggestion: '确认成本是否遗漏' })
    } else {
      checks.push({ name: '利润率', status: 'passed', message: `毛利率${margin}%，利润¥${profit.toLocaleString()}` })
    }

    if (cost > revenue * (currency === 'CNY' ? 1 : rate) * 2) {
      checks.push({ name: '成本比例', status: 'error', message: '总成本超过收入的2倍', suggestion: '请检查成本明细' })
    }
  }

  // --- 4. 客户信息完整性 ---
  if (!customer || !(customer.company as string)) {
    checks.push({ name: '客户信息', status: 'error', message: '未关联客户', suggestion: '请选择客户' })
  } else {
    const missing: string[] = []
    if (!(customer.country as string)) missing.push('国家')
    if (missing.length > 0) {
      checks.push({ name: '客户信息', status: 'warning', message: `客户${customer.company}缺少：${missing.join('、')}`, suggestion: '建议补全客户资料' })
    } else {
      checks.push({ name: '客户信息', status: 'passed', message: `${customer.company} (${customer.country})` })
    }
  }

  // --- 5. 费用归集核对（跨表） ---
  const { data: costItems } = await supabase
    .from('cost_items')
    .select('amount, cost_type, supplier, description')
    .eq('budget_order_id', orderId)

  const costItemsTotal = (costItems || []).reduce((s, c) => s + ((c.amount as number) || 0), 0)

  if (costItems && costItems.length > 0) {
    const variance = Math.abs(costItemsTotal - cost)
    const varianceRate = cost > 0 ? variance / cost * 100 : 0

    if (varianceRate > 30) {
      checks.push({
        name: '费用归集',
        status: 'warning',
        message: `实际录入费用¥${costItemsTotal.toLocaleString()} vs 预算成本¥${cost.toLocaleString()}，差异${varianceRate.toFixed(0)}%`,
        suggestion: '请核实预算是否需要调整',
      })
    } else {
      checks.push({ name: '费用归集', status: 'passed', message: `${costItems.length}笔费用，合计¥${costItemsTotal.toLocaleString()}` })
    }

    // 检查供应商名称近似重复
    const suppliers = [...new Set((costItems || []).map(c => (c.supplier as string) || '').filter(Boolean))]
    for (let i = 0; i < suppliers.length; i++) {
      for (let j = i + 1; j < suppliers.length; j++) {
        if (suppliers[i].includes(suppliers[j]) || suppliers[j].includes(suppliers[i])) {
          checks.push({
            name: '供应商一致性',
            status: 'warning',
            message: `供应商名称可能重复："${suppliers[i]}" 和 "${suppliers[j]}"`,
            suggestion: '请统一供应商名称',
          })
        }
      }
    }
  } else {
    checks.push({ name: '费用归集', status: 'info' as GateCheck['status'], message: '暂无录入费用（可在审批后补录）' })
  }

  // --- 6. 订单日期 ---
  if (!order.order_date) {
    checks.push({ name: '订单日期', status: 'warning', message: '未设置下单日期', suggestion: '建议填写' })
  } else {
    checks.push({ name: '订单日期', status: 'passed', message: order.order_date as string })
  }

  return buildResult(checks)
}

// ========== 费用录入前全域核查 ==========

export async function runCostSubmitGate(params: {
  amount: number
  orderId: string
  costType: string
  supplier: string
}): Promise<GateResult> {
  const supabase = createClient()
  const checks: GateCheck[] = []
  const { amount, orderId, costType, supplier } = params

  if (!orderId) return buildResult([{ name: '关联订单', status: 'passed', message: '未关联订单（独立费用）' }])

  // 查订单预算
  const { data: order } = await supabase
    .from('budget_orders')
    .select('total_cost, total_revenue, exchange_rate, currency')
    .eq('id', orderId)
    .single()

  if (!order) return buildResult(checks)

  const budgetCost = (order.total_cost as number) || 0

  // 查已有费用
  const { data: existing } = await supabase
    .from('cost_items')
    .select('amount, cost_type, supplier')
    .eq('budget_order_id', orderId)

  const existingTotal = (existing || []).reduce((s, c) => s + ((c.amount as number) || 0), 0)
  const afterTotal = existingTotal + amount

  // 1. 累计费用 vs 预算
  if (budgetCost > 0 && afterTotal > budgetCost * 0.8) {
    const pct = Math.round(afterTotal / budgetCost * 100)
    checks.push({
      name: '费用累计',
      status: afterTotal > budgetCost ? 'warning' : 'info' as GateCheck['status'],
      message: `本次录入后累计¥${afterTotal.toLocaleString()}，占预算${pct}%${afterTotal > budgetCost ? '（已超预算）' : ''}`,
      suggestion: afterTotal > budgetCost ? '请确认是否需要调整预算' : undefined,
    })
  } else {
    checks.push({ name: '费用累计', status: 'passed', message: `累计¥${afterTotal.toLocaleString()} / 预算¥${budgetCost.toLocaleString()}` })
  }

  // 2. 同类型费用是否已录入
  const sameType = (existing || []).filter(c => c.cost_type === costType)
  if (sameType.length > 0) {
    const typeTotal = sameType.reduce((s, c) => s + ((c.amount as number) || 0), 0)
    checks.push({
      name: '同类费用',
      status: 'info' as GateCheck['status'],
      message: `该订单已有${sameType.length}笔同类费用(合计¥${typeTotal.toLocaleString()})，本次新增¥${amount.toLocaleString()}`,
    })
  }

  // 3. 供应商名称近似检查
  if (supplier) {
    const allSuppliers = [...new Set((existing || []).map(c => (c.supplier as string) || '').filter(Boolean))]
    const similar = allSuppliers.find(s => s !== supplier && (s.includes(supplier) || supplier.includes(s)))
    if (similar) {
      checks.push({
        name: '供应商名称',
        status: 'warning',
        message: `已有近似供应商"${similar}"，本次输入"${supplier}"`,
        suggestion: '请确认是否同一供应商',
      })
    }
  }

  return buildResult(checks)
}

// ========== 付款审批前核查 ==========

export async function runPaymentApproveGate(payableId: string): Promise<GateResult> {
  const supabase = createClient()
  const checks: GateCheck[] = []

  const { data: payable } = await supabase
    .from('payable_records')
    .select('*')
    .eq('id', payableId)
    .single()

  if (!payable) return buildResult([{ name: '应付记录', status: 'error', message: '记录不存在' }])

  const amount = (payable.amount as number) || 0
  const supplier = payable.supplier_name as string

  // 1. 金额校验
  if (amount <= 0) {
    checks.push({ name: '付款金额', status: 'error', message: '金额为0' })
  } else if (amount > 500000) {
    checks.push({ name: '付款金额', status: 'warning', message: `金额¥${amount.toLocaleString()}超过50万，请确认` })
  } else {
    checks.push({ name: '付款金额', status: 'passed', message: `¥${amount.toLocaleString()}` })
  }

  // 2. 供应商是否冻结
  const { data: freezes } = await supabase
    .from('entity_freezes')
    .select('id')
    .eq('entity_type', 'supplier')
    .ilike('entity_name', `%${supplier}%`)
    .eq('status', 'frozen')
    .limit(1)

  if (freezes && freezes.length > 0) {
    checks.push({ name: '供应商状态', status: 'error', message: `${supplier}已被冻结，不能付款`, suggestion: '请先解冻' })
  } else {
    checks.push({ name: '供应商状态', status: 'passed', message: `${supplier} 正常` })
  }

  // 3. 重复付款检测
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recentPaid } = await supabase
    .from('payable_records')
    .select('amount, paid_at')
    .eq('supplier_name', supplier)
    .eq('payment_status', 'paid')
    .gte('paid_at', weekAgo)

  if (recentPaid && recentPaid.length > 0) {
    const similar = recentPaid.find(p => Math.abs((p.amount as number) - amount) / amount < 0.05)
    if (similar) {
      checks.push({
        name: '重复付款',
        status: 'warning',
        message: `7天内已向${supplier}付过¥${(similar.amount as number).toLocaleString()}，金额接近本次`,
        suggestion: '请确认不是重复付款',
      })
    }
  }

  if (checks.filter(c => c.status === 'passed').length === checks.length) {
    checks.push({ name: '整体评估', status: 'passed', message: '所有检查通过' })
  }

  return buildResult(checks)
}
