// ============================================================
// 自动对账 Agent — 银行流水↔发票↔订单 自动匹配
// ============================================================

export interface ReconciliationItem {
  type: 'matched' | 'unmatched_payment' | 'unmatched_invoice' | 'amount_mismatch' | 'duplicate'
  severity: 'info' | 'warning' | 'critical'
  description: string
  payment_ref?: string
  invoice_ref?: string
  payment_amount?: number
  invoice_amount?: number
  difference?: number
  suggested_action: string
}

// 自动匹配银行流水和发票
export function autoReconcile(
  payments: { ref: string; amount: number; payer: string; date: string; currency: string }[],
  invoices: { ref: string; amount: number; customer: string; date: string; currency: string; status: string }[]
): ReconciliationItem[] {
  const results: ReconciliationItem[] = []
  const matchedInvoices = new Set<string>()
  const matchedPayments = new Set<string>()

  // 1. 精确匹配（金额完全一致）
  for (const payment of payments) {
    const exactMatch = invoices.find(inv =>
      !matchedInvoices.has(inv.ref) &&
      Math.abs(inv.amount - payment.amount) < 0.01 &&
      inv.currency === payment.currency
    )

    if (exactMatch) {
      results.push({
        type: 'matched',
        severity: 'info',
        description: `收款 ${payment.ref} (${payment.currency} ${payment.amount.toLocaleString()}) 匹配发票 ${exactMatch.ref}`,
        payment_ref: payment.ref,
        invoice_ref: exactMatch.ref,
        payment_amount: payment.amount,
        invoice_amount: exactMatch.amount,
        difference: 0,
        suggested_action: '自动核销',
      })
      matchedInvoices.add(exactMatch.ref)
      matchedPayments.add(payment.ref)
    }
  }

  // 2. 模糊匹配（金额差异<5%，可能是汇率差异）
  for (const payment of payments) {
    if (matchedPayments.has(payment.ref)) continue

    const fuzzyMatch = invoices.find(inv =>
      !matchedInvoices.has(inv.ref) &&
      inv.currency === payment.currency &&
      Math.abs(inv.amount - payment.amount) / inv.amount < 0.05
    )

    if (fuzzyMatch) {
      const diff = payment.amount - fuzzyMatch.amount
      results.push({
        type: 'amount_mismatch',
        severity: 'warning',
        description: `收款 ${payment.ref} 与发票 ${fuzzyMatch.ref} 金额差异 ${payment.currency} ${diff.toFixed(2)}`,
        payment_ref: payment.ref,
        invoice_ref: fuzzyMatch.ref,
        payment_amount: payment.amount,
        invoice_amount: fuzzyMatch.amount,
        difference: diff,
        suggested_action: Math.abs(diff) < 100 ? '可能是汇率差异，建议确认后核销' : '差额较大，需人工核实',
      })
      matchedInvoices.add(fuzzyMatch.ref)
      matchedPayments.add(payment.ref)
    }
  }

  // 3. 未匹配的收款
  for (const payment of payments) {
    if (matchedPayments.has(payment.ref)) continue
    results.push({
      type: 'unmatched_payment',
      severity: 'warning',
      description: `收款 ${payment.ref} (${payment.payer}, ${payment.currency} ${payment.amount.toLocaleString()}) 未找到对应发票`,
      payment_ref: payment.ref,
      payment_amount: payment.amount,
      suggested_action: '检查是否为预付款或其他订单回款',
    })
  }

  // 4. 未收款的发票
  for (const invoice of invoices) {
    if (matchedInvoices.has(invoice.ref) || invoice.status === 'paid') continue
    results.push({
      type: 'unmatched_invoice',
      severity: invoice.status === 'pending' ? 'warning' : 'info',
      description: `发票 ${invoice.ref} (${invoice.customer}, ${invoice.currency} ${invoice.amount.toLocaleString()}) 未收到付款`,
      invoice_ref: invoice.ref,
      invoice_amount: invoice.amount,
      suggested_action: '跟进客户付款状态',
    })
  }

  // 5. 检测重复付款
  const amountMap = new Map<string, string[]>()
  for (const payment of payments) {
    const key = `${payment.payer}-${payment.amount}-${payment.currency}`
    const existing = amountMap.get(key) || []
    existing.push(payment.ref)
    amountMap.set(key, existing)
  }
  for (const [, refs] of amountMap) {
    if (refs.length > 1) {
      results.push({
        type: 'duplicate',
        severity: 'critical',
        description: `疑似重复付款: ${refs.join(', ')} 金额完全一致`,
        suggested_action: '立即核实是否重复付款',
      })
    }
  }

  return results.sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 }
    return order[a.severity] - order[b.severity]
  })
}

// 对账摘要
export function getReconciliationSummary(items: ReconciliationItem[]) {
  return {
    total: items.length,
    matched: items.filter(i => i.type === 'matched').length,
    mismatched: items.filter(i => i.type === 'amount_mismatch').length,
    unmatched_payments: items.filter(i => i.type === 'unmatched_payment').length,
    unmatched_invoices: items.filter(i => i.type === 'unmatched_invoice').length,
    duplicates: items.filter(i => i.type === 'duplicate').length,
    needs_attention: items.filter(i => i.severity === 'critical' || i.severity === 'warning').length,
  }
}
