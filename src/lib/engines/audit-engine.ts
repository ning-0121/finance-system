// ============================================================
// Audit Engine — Financial Anomaly Detection
// ============================================================
// 7 automated audit checks that scan for irregularities across
// orders, payments, invoices, and settlements. Findings are
// persisted to audit_findings and can be resolved with notes.

import { createClient } from '@/lib/supabase/client'
import { safeRate } from '@/lib/accounting/utils'

// --------------- Types ---------------

export interface AuditFinding {
  id: string
  findingType: string
  severity: 'info' | 'warning' | 'critical'
  entityType: string
  entityId: string | null
  title: string
  description: string
  evidence: Record<string, unknown> | null
  status: 'open' | 'investigating' | 'resolved' | 'dismissed'
  resolvedBy: string | null
  resolvedAt: string | null
  resolutionNote: string | null
  createdAt: string
}

// --------------- Helpers ---------------

function mapFinding(row: Record<string, unknown>): AuditFinding {
  return {
    id: row.id as string,
    findingType: row.finding_type as string,
    severity: row.severity as AuditFinding['severity'],
    entityType: row.entity_type as string,
    entityId: (row.entity_id as string) ?? null,
    title: row.title as string,
    description: row.description as string,
    evidence: (row.evidence as Record<string, unknown>) ?? null,
    status: row.status as AuditFinding['status'],
    resolvedBy: (row.resolved_by as string) ?? null,
    resolvedAt: (row.resolved_at as string) ?? null,
    resolutionNote: (row.resolution_note as string) ?? null,
    createdAt: row.created_at as string,
  }
}

async function insertFindings(findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[]): Promise<AuditFinding[]> {
  if (findings.length === 0) return []
  const supabase = createClient()

  const rows = findings.map((f) => ({
    finding_type: f.findingType,
    severity: f.severity,
    entity_type: f.entityType,
    entity_id: f.entityId,
    title: f.title,
    description: f.description,
    evidence: f.evidence,
    status: f.status,
  }))

  const { data, error } = await supabase
    .from('audit_findings')
    .insert(rows)
    .select('*')

  if (error) throw new Error(`写入稽核发现失败: ${error.message}`)
  return (data || []).map(mapFinding)
}

// --------------- Public API ---------------

/**
 * Run all 7 audit checks. Returns combined findings.
 */
export async function runFullAudit(): Promise<AuditFinding[]> {
  const results = await Promise.all([
    auditDuplicatePayments(),
    auditAmountMismatches(),
    auditMissingVouchers(),
    auditTimingAnomalies(),
    auditMarginOutliers(),
    auditOrphanedPayments(),
    auditOverdueCollections(),
  ])
  return results.flat()
}

/**
 * Check 1: Duplicate payments — same supplier + same amount within 7 days.
 */
export async function auditDuplicatePayments(): Promise<AuditFinding[]> {
  const supabase = createClient()
  const { data: payables } = await supabase
    .from('payable_records')
    .select('id, order_no, supplier_name, amount, currency, created_at, payment_status')
    .in('payment_status', ['paid', 'approved'])
    .order('created_at', { ascending: true })

  if (!payables?.length) return []

  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []
  const seenPairs = new Set<string>()

  for (let i = 0; i < payables.length; i++) {
    for (let j = i + 1; j < payables.length; j++) {
      const a = payables[i]
      const b = payables[j]

      if (
        a.supplier_name === b.supplier_name &&
        Math.abs((a.amount as number) - (b.amount as number)) < 0.01
      ) {
        const dayDiff = Math.abs(
          new Date(b.created_at as string).getTime() -
            new Date(a.created_at as string).getTime()
        ) / (1000 * 60 * 60 * 24)

        if (dayDiff <= 7) {
          const pairKey = [a.id, b.id].sort().join('-')
          if (seenPairs.has(pairKey)) continue
          seenPairs.add(pairKey)

          findings.push({
            findingType: 'duplicate_payment',
            severity: 'critical',
            entityType: 'payable_record',
            entityId: b.id as string,
            title: `疑似重复付款: ${a.supplier_name}`,
            description: `供应商"${a.supplier_name}"在${dayDiff.toFixed(0)}天内有两笔相同金额(${a.currency} ${a.amount})的付款记录`,
            evidence: {
              recordA: { id: a.id, orderNo: a.order_no, amount: a.amount, date: a.created_at },
              recordB: { id: b.id, orderNo: b.order_no, amount: b.amount, date: b.created_at },
              daysBetween: Math.round(dayDiff),
            },
            status: 'open',
          })
        }
      }
    }
  }

  return insertFindings(findings)
}

/**
 * Check 2: Amount mismatches — invoice total vs budget >15% variance.
 */
export async function auditAmountMismatches(): Promise<AuditFinding[]> {
  const supabase = createClient()
  const { data: invoices } = await supabase
    .from('actual_invoices')
    .select('id, budget_order_id, invoice_no, invoice_type, total_amount, currency')

  if (!invoices?.length) return []

  // Load corresponding budget orders
  const budgetIdSet: Record<string, boolean> = {}
  invoices.forEach((i) => { if (i.budget_order_id) budgetIdSet[i.budget_order_id as string] = true })
  const budgetIds = Object.keys(budgetIdSet)
  if (budgetIds.length === 0) return []

  const { data: budgets } = await supabase
    .from('budget_orders')
    .select('id, order_no, total_cost, total_revenue')
    .in('id', budgetIds)

  const budgetMap: Record<string, { id: string; order_no: string; total_cost: number; total_revenue: number }> = {}
  for (const b of budgets || []) {
    budgetMap[b.id as string] = b as { id: string; order_no: string; total_cost: number; total_revenue: number }
  }

  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []

  // Group invoices by budget order and sum totals
  const orderInvoiceTotals: Record<string, number> = {}
  for (const inv of invoices) {
    const boId = inv.budget_order_id as string
    if (!boId) continue
    orderInvoiceTotals[boId] = (orderInvoiceTotals[boId] || 0) + (inv.total_amount as number)
  }

  for (const boId of Object.keys(orderInvoiceTotals)) {
    const invoiceTotal = orderInvoiceTotals[boId]
    const budget = budgetMap[boId]
    if (!budget) continue

    const budgetCost = budget.total_cost
    if (budgetCost <= 0) continue

    const variance = ((invoiceTotal - budgetCost) / budgetCost) * 100
    if (Math.abs(variance) > 15) {
      findings.push({
        findingType: 'amount_mismatch',
        severity: variance > 30 ? 'critical' : 'warning',
        entityType: 'budget_order',
        entityId: boId,
        title: `发票与预算偏差过大: ${budget.order_no}`,
        description: `订单${budget.order_no}的发票合计${invoiceTotal.toFixed(2)}与预算成本${budgetCost.toFixed(2)}偏差${variance.toFixed(1)}%, 超过15%阈值`,
        evidence: {
          orderNo: budget.order_no,
          budgetCost,
          invoiceTotal,
          variancePercent: Math.round(variance * 10) / 10,
        },
        status: 'open',
      })
    }
  }

  return insertFindings(findings)
}

/**
 * Check 3: Missing vouchers — confirmed settlements without journal entries.
 */
export async function auditMissingVouchers(): Promise<AuditFinding[]> {
  const supabase = createClient()
  const { data: settlements } = await supabase
    .from('order_settlements')
    .select('id, budget_order_id, total_actual, status')
    .in('status', ['confirmed', 'locked'])

  if (!settlements?.length) return []

  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []

  for (const s of settlements) {
    // Check if a journal entry exists for this settlement
    const { count } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('source_type', 'settlement')
      .eq('source_id', s.budget_order_id as string)

    if ((count ?? 0) === 0) {
      // Look up order_no
      const { data: order } = await supabase
        .from('budget_orders')
        .select('order_no')
        .eq('id', s.budget_order_id as string)
        .single()

      findings.push({
        findingType: 'missing_voucher',
        severity: 'warning',
        entityType: 'order_settlement',
        entityId: s.id as string,
        title: `决算缺少记账凭证: ${order?.order_no || s.budget_order_id}`,
        description: `决算单已${s.status === 'locked' ? '锁定' : '确认'}但未找到对应的记账凭证, 金额${s.total_actual}`,
        evidence: {
          settlementId: s.id,
          budgetOrderId: s.budget_order_id,
          orderNo: order?.order_no,
          totalActual: s.total_actual,
          status: s.status,
        },
        status: 'open',
      })
    }
  }

  return insertFindings(findings)
}

/**
 * Check 4: Timing anomalies — invoices dated before the order date.
 */
export async function auditTimingAnomalies(): Promise<AuditFinding[]> {
  const supabase = createClient()
  const { data: invoices } = await supabase
    .from('actual_invoices')
    .select('id, budget_order_id, invoice_no, invoice_date, total_amount, supplier_name')
    .not('invoice_date', 'is', null)

  if (!invoices?.length) return []

  const budgetIdSet2: Record<string, boolean> = {}
  invoices.forEach((i) => { if (i.budget_order_id) budgetIdSet2[i.budget_order_id as string] = true })
  const budgetIds = Object.keys(budgetIdSet2)
  if (budgetIds.length === 0) return []

  const { data: orders } = await supabase
    .from('budget_orders')
    .select('id, order_no, order_date')
    .in('id', budgetIds)

  const orderMap: Record<string, { id: string; order_no: string; order_date: string }> = {}
  for (const o of orders || []) {
    orderMap[o.id as string] = o as { id: string; order_no: string; order_date: string }
  }

  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []

  for (const inv of invoices) {
    const boId = inv.budget_order_id as string
    if (!boId) continue
    const order = orderMap[boId]
    if (!order) continue

    const invoiceDate = new Date(inv.invoice_date as string)
    const orderDate = new Date(order.order_date)

    if (invoiceDate < orderDate) {
      const daysBefore = Math.ceil(
        (orderDate.getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24)
      )
      findings.push({
        findingType: 'timing_anomaly',
        severity: daysBefore > 30 ? 'critical' : 'warning',
        entityType: 'actual_invoice',
        entityId: inv.id as string,
        title: `发票日期早于订单: ${inv.invoice_no}`,
        description: `发票${inv.invoice_no}的日期(${inv.invoice_date})早于订单${order.order_no}的日期(${order.order_date}), 相差${daysBefore}天`,
        evidence: {
          invoiceNo: inv.invoice_no,
          invoiceDate: inv.invoice_date,
          orderNo: order.order_no,
          orderDate: order.order_date,
          daysBefore,
          supplierName: inv.supplier_name,
          amount: inv.total_amount,
        },
        status: 'open',
      })
    }
  }

  return insertFindings(findings)
}

/**
 * Check 5: Margin outliers — orders with margin <5% or >50%.
 */
export async function auditMarginOutliers(): Promise<AuditFinding[]> {
  const supabase = createClient()
  const { data: orders } = await supabase
    .from('budget_orders')
    .select('id, order_no, customer_id, total_revenue, total_cost, estimated_margin, status')
    .in('status', ['approved', 'closed'])

  if (!orders?.length) return []

  // Load customer names
  const custIdSet: Record<string, boolean> = {}
  orders.forEach((o) => { if (o.customer_id) custIdSet[o.customer_id as string] = true })
  const customerIds = Object.keys(custIdSet)
  const { data: customers } = await supabase
    .from('customers')
    .select('id, company')
    .in('id', customerIds)

  const customerMap: Record<string, string> = {}
  for (const c of customers || []) {
    customerMap[c.id as string] = c.company as string
  }

  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []

  for (const order of orders) {
    const revenue = Number(order.total_revenue) || 0
    const cost = Number(order.total_cost) || 0
    if (revenue <= 0) continue

    const margin = ((revenue - cost) / revenue) * 100

    if (margin < 5) {
      findings.push({
        findingType: 'margin_outlier',
        severity: margin < 0 ? 'critical' : 'warning',
        entityType: 'budget_order',
        entityId: order.id as string,
        title: `低利润率订单: ${order.order_no}`,
        description: `订单${order.order_no}(${customerMap[order.customer_id as string] || '未知客户'})利润率仅${margin.toFixed(1)}%, 低于5%阈值`,
        evidence: {
          orderNo: order.order_no,
          customer: customerMap[order.customer_id as string],
          revenue,
          cost,
          profit: revenue - cost,
          marginPercent: Math.round(margin * 10) / 10,
        },
        status: 'open',
      })
    } else if (margin > 50) {
      findings.push({
        findingType: 'margin_outlier',
        severity: 'warning',
        entityType: 'budget_order',
        entityId: order.id as string,
        title: `异常高利润率: ${order.order_no}`,
        description: `订单${order.order_no}利润率${margin.toFixed(1)}%异常偏高(>50%), 请核实数据准确性`,
        evidence: {
          orderNo: order.order_no,
          customer: customerMap[order.customer_id as string],
          revenue,
          cost,
          profit: revenue - cost,
          marginPercent: Math.round(margin * 10) / 10,
        },
        status: 'open',
      })
    }
  }

  return insertFindings(findings)
}

/**
 * Check 6: Orphaned payments — payable_records without matching budget_orders.
 */
export async function auditOrphanedPayments(): Promise<AuditFinding[]> {
  const supabase = createClient()
  const { data: payables } = await supabase
    .from('payable_records')
    .select('id, budget_order_id, order_no, supplier_name, amount, currency, payment_status')
    .is('budget_order_id', null)

  if (!payables?.length) return []

  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []

  for (const p of payables) {
    findings.push({
      findingType: 'orphaned_payment',
      severity: 'warning',
      entityType: 'payable_record',
      entityId: p.id as string,
      title: `孤立付款记录: ${p.supplier_name}`,
      description: `付款记录(供应商: ${p.supplier_name}, 金额: ${p.currency} ${p.amount})未关联任何预算订单`,
      evidence: {
        payableId: p.id,
        orderNo: p.order_no,
        supplierName: p.supplier_name,
        amount: p.amount,
        currency: p.currency,
        paymentStatus: p.payment_status,
      },
      status: 'open',
    })
  }

  return insertFindings(findings)
}

/**
 * Check 7: Overdue collections — AR outstanding >60 days.
 */
export async function auditOverdueCollections(): Promise<AuditFinding[]> {
  const supabase = createClient()
  const { data: orders } = await supabase
    .from('budget_orders')
    .select('id, order_no, customer_id, total_revenue, exchange_rate, currency, order_date, status')
    .eq('status', 'approved')

  if (!orders?.length) return []

  const now = new Date()
  const custIdSet2: Record<string, boolean> = {}
  orders.forEach((o) => { if (o.customer_id) custIdSet2[o.customer_id as string] = true })
  const customerIds = Object.keys(custIdSet2)
  const { data: customers } = await supabase
    .from('customers')
    .select('id, company')
    .in('id', customerIds)

  const customerMap: Record<string, string> = {}
  for (const c of customers || []) {
    customerMap[c.id as string] = c.company as string
  }

  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []

  for (const order of orders) {
    const orderDate = new Date(order.order_date as string)
    const daysOutstanding = Math.floor(
      (now.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24)
    )

    if (daysOutstanding > 60) {
      const rate = safeRate(order.exchange_rate as number, order.currency as string, `audit overdue order ${order.id}`)
      const amountCny = (order.total_revenue as number) * rate
      findings.push({
        findingType: 'overdue_collection',
        severity: daysOutstanding > 90 ? 'critical' : 'warning',
        entityType: 'budget_order',
        entityId: order.id as string,
        title: `应收超期: ${order.order_no}`,
        description: `订单${order.order_no}(${customerMap[order.customer_id as string] || '未知客户'})已超${daysOutstanding}天未收款, 金额约¥${Math.round(amountCny)}`,
        evidence: {
          orderNo: order.order_no,
          customer: customerMap[order.customer_id as string],
          orderDate: order.order_date,
          daysOutstanding,
          amount: order.total_revenue,
          currency: order.currency,
          amountCny: Math.round(amountCny),
        },
        status: 'open',
      })
    }
  }

  return insertFindings(findings)
}

/**
 * Resolve an audit finding with notes.
 */
export async function resolveAuditFinding(
  findingId: string,
  resolution: string,
  resolvedBy: string
): Promise<void> {
  const supabase = createClient()

  const { error } = await supabase
    .from('audit_findings')
    .update({
      status: 'resolved',
      resolution_note: resolution,
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', findingId)

  if (error) throw new Error(`解决稽核发现失败: ${error.message}`)
}

/**
 * Query audit findings with optional filters.
 */
export async function getAuditFindings(filters?: {
  status?: string
  severity?: string
  entityType?: string
}): Promise<AuditFinding[]> {
  const supabase = createClient()

  let query = supabase
    .from('audit_findings')
    .select('*')
    .order('created_at', { ascending: false })

  if (filters?.status) {
    query = query.eq('status', filters.status)
  }
  if (filters?.severity) {
    query = query.eq('severity', filters.severity)
  }
  if (filters?.entityType) {
    query = query.eq('entity_type', filters.entityType)
  }

  const { data, error } = await query
  if (error) throw new Error(`查询稽核发现失败: ${error.message}`)

  return (data || []).map(mapFinding)
}
