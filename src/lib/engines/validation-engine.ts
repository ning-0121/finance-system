// 财务防错引擎 — 让二把刀也能做对
// 所有输入页面调用同一套规则，中文提示，防错不阻断

export interface ValidationWarning {
  level: 'error' | 'warning' | 'info'
  message: string
  field: string
  suggestion?: string
}

// ========== 费用录入校验 ==========

export function validateCostEntry(params: {
  amount: number
  description: string
  supplier: string
  costType: string
  currency: string
  exchangeRate: number
  orderRevenue?: number
  orderCost?: number
  existingCosts?: { supplier: string; description: string; amount: number }[]
}): ValidationWarning[] {
  const warnings: ValidationWarning[] = []
  const { amount, description, supplier, currency, exchangeRate, orderRevenue, existingCosts } = params

  // 金额基础校验
  warnings.push(...validateAmount(amount, '金额'))

  // 汇率校验
  warnings.push(...validateExchangeRate(currency, exchangeRate))

  // 供应商校验
  if (supplier) {
    if (supplier.trim() !== supplier) {
      warnings.push({ level: 'info', field: 'supplier', message: '供应商名称前后有空格，已自动去除' })
    }
    if (supplier.trim().length < 2) {
      warnings.push({ level: 'warning', field: 'supplier', message: '供应商名称过短，请确认' })
    }
  }

  // 描述校验
  if (!description || description.trim().length < 2) {
    warnings.push({ level: 'warning', field: 'description', message: '费用描述过短，建议写清楚用途' })
  }

  // 费用 vs 订单收入校验
  if (orderRevenue && orderRevenue > 0 && amount > orderRevenue * 0.5) {
    warnings.push({
      level: 'warning', field: 'amount',
      message: `这笔费用(¥${amount.toLocaleString()})超过订单收入的50%，请确认`,
    })
  }

  // 重复检测
  if (existingCosts && existingCosts.length > 0) {
    const duplicate = existingCosts.find(c =>
      c.supplier === supplier.trim() &&
      c.description === description.trim() &&
      Math.abs(c.amount - amount) / Math.max(c.amount, 1) < 0.1 // ±10%
    )
    if (duplicate) {
      warnings.push({
        level: 'warning', field: 'amount',
        message: `可能重复：已有${duplicate.supplier}的"${duplicate.description}"¥${duplicate.amount.toLocaleString()}`,
      })
    }

    // 历史均值检测
    const sameSupplier = existingCosts.filter(c => c.supplier === supplier.trim())
    if (sameSupplier.length >= 2) {
      const avg = sameSupplier.reduce((s, c) => s + c.amount, 0) / sameSupplier.length
      if (amount < avg * 0.1) {
        warnings.push({
          level: 'warning', field: 'amount',
          message: `${supplier}历史平均¥${Math.round(avg).toLocaleString()}，本次仅¥${amount.toLocaleString()}，是否输少了？`,
          suggestion: `¥${Math.round(avg).toLocaleString()}`,
        })
      }
      if (amount > avg * 10) {
        warnings.push({
          level: 'warning', field: 'amount',
          message: `${supplier}历史平均¥${Math.round(avg).toLocaleString()}，本次¥${amount.toLocaleString()}是平均的${Math.round(amount / avg)}倍，是否输多了？`,
        })
      }
    }
  }

  return warnings
}

// ========== 预算编辑校验 ==========

export function validateBudgetEdit(params: {
  revenue: number
  rate: number
  currency: string
  costs: Record<string, number>
}): ValidationWarning[] {
  const warnings: ValidationWarning[] = []
  const { revenue, rate, currency, costs } = params

  // 收入校验
  if (revenue <= 0) {
    warnings.push({ level: 'error', field: 'revenue', message: '合同金额不能为0' })
  }
  warnings.push(...validateAmount(revenue, '合同金额'))

  // 汇率校验
  warnings.push(...validateExchangeRate(currency, rate))

  // 成本各项校验
  const revenueCny = currency === 'CNY' ? revenue : revenue * rate
  const totalCost = Object.values(costs).reduce((s, v) => s + (v || 0), 0)

  for (const [key, value] of Object.entries(costs)) {
    if (value < 0) {
      warnings.push({ level: 'error', field: key, message: `${getCostLabel(key)}不能为负数` })
    }
    if (value > revenueCny * 0.8) {
      warnings.push({
        level: 'warning', field: key,
        message: `${getCostLabel(key)}(¥${value.toLocaleString()})超过收入的80%，请确认`,
      })
    }
  }

  // 利润率检测
  if (revenueCny > 0) {
    const profit = revenueCny - totalCost
    const margin = profit / revenueCny * 100

    if (margin < 0) {
      warnings.push({ level: 'error', field: 'profit', message: `订单亏损！利润¥${Math.round(profit).toLocaleString()}` })
    } else if (margin < 5) {
      warnings.push({ level: 'warning', field: 'profit', message: `毛利率仅${margin.toFixed(1)}%，低于5%警戒线` })
    } else if (margin > 60) {
      warnings.push({ level: 'warning', field: 'profit', message: `毛利率${margin.toFixed(1)}%异常偏高，请核实成本` })
    }

    if (totalCost > revenueCny * 2) {
      warnings.push({ level: 'error', field: 'totalCost', message: `总成本(¥${totalCost.toLocaleString()})是收入的2倍以上，请检查` })
    }
  }

  return warnings
}

// ========== 付款申请校验 ==========

export function validatePayment(params: {
  amount: number
  supplier: string
  dueDate?: string
  existingPayables?: { supplier: string; amount: number }[]
}): ValidationWarning[] {
  const warnings: ValidationWarning[] = []
  const { amount, supplier, dueDate, existingPayables } = params

  // 金额校验
  warnings.push(...validateAmount(amount, '付款金额'))

  // 供应商校验
  if (!supplier || supplier.trim().length < 2) {
    warnings.push({ level: 'error', field: 'supplier', message: '请输入供应商名称' })
  }

  // 到期日校验
  if (dueDate) {
    const due = new Date(dueDate)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (due < today) {
      warnings.push({ level: 'info', field: 'dueDate', message: '到期日已过，请确认' })
    }
  }

  // 重复检测
  if (existingPayables) {
    const dup = existingPayables.find(p =>
      p.supplier === supplier.trim() &&
      Math.abs(p.amount - amount) / Math.max(p.amount, 1) < 0.05
    )
    if (dup) {
      warnings.push({
        level: 'warning', field: 'amount',
        message: `${supplier}已有一笔¥${dup.amount.toLocaleString()}的付款申请，可能重复`,
      })
    }
  }

  return warnings
}

// ========== 通用校验函数 ==========

function validateAmount(amount: number, label: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = []

  if (!amount || amount === 0) {
    warnings.push({ level: 'error', field: 'amount', message: `${label}不能为0` })
    return warnings
  }
  if (amount < 0) {
    warnings.push({ level: 'error', field: 'amount', message: `${label}不能为负数` })
    return warnings
  }
  if (amount < 1) {
    warnings.push({ level: 'warning', field: 'amount', message: `${label}小于1元(¥${amount})，请确认` })
  }
  if (amount > 1000000) {
    warnings.push({
      level: 'warning', field: 'amount',
      message: `${label}超过100万(¥${amount.toLocaleString()})，请确认是否正确`,
    })
  }

  // 千万混淆检测：如果金额是整千/整万，提醒确认
  if (amount >= 10000 && amount % 10000 === 0) {
    const wan = amount / 10000
    warnings.push({
      level: 'info', field: 'amount',
      message: `${label}为${wan}万元(¥${amount.toLocaleString()})，请确认`,
    })
  }

  // 可能少打了一个0：金额在10-999之间且是整十数
  if (amount >= 10 && amount <= 999 && amount % 10 === 0) {
    warnings.push({
      level: 'info', field: 'amount',
      message: `${label}为¥${amount}，是否应该是¥${(amount * 10).toLocaleString()}？`,
      suggestion: `¥${(amount * 10).toLocaleString()}`,
    })
  }

  return warnings
}

function validateExchangeRate(currency: string, rate: number): ValidationWarning[] {
  const warnings: ValidationWarning[] = []

  if (currency === 'CNY') {
    if (rate !== 1 && rate !== 0) {
      warnings.push({ level: 'error', field: 'exchangeRate', message: '人民币汇率应为1' })
    }
  } else if (currency === 'USD') {
    if (rate < 5 || rate > 9) {
      warnings.push({
        level: 'warning', field: 'exchangeRate',
        message: `美元汇率${rate}不在正常范围(5-9)，当前约6.9-7.2`,
        suggestion: '6.9',
      })
    }
  } else if (currency === 'EUR') {
    if (rate < 6 || rate > 10) {
      warnings.push({ level: 'warning', field: 'exchangeRate', message: `欧元汇率${rate}不在正常范围(6-10)` })
    }
  }

  if (rate <= 0 && currency !== 'CNY') {
    warnings.push({ level: 'error', field: 'exchangeRate', message: '汇率必须大于0' })
  }

  return warnings
}

function getCostLabel(key: string): string {
  const labels: Record<string, string> = {
    fabric: '面料', accessory: '辅料', processing: '加工费',
    forwarder: '货代费', container: '装柜费', logistics: '物流费',
  }
  return labels[key] || key
}
