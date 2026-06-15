// ============================================================
// Audit Engine — Financial Anomaly Detection
// ============================================================
// 11 automated audit checks that scan for irregularities across
// orders, payments, invoices, and settlements. Findings are
// persisted to audit_findings and can be resolved with notes.

import { createClient } from '@/lib/supabase/server'
import { safeRate } from '@/lib/accounting/utils'
import { bizToday } from '@/lib/biz-date'
import type { SupabaseClient } from '@supabase/supabase-js'

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

async function insertFindings(db: SupabaseClient, findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[]): Promise<AuditFinding[]> {
  if (findings.length === 0) return []
  const supabase = db

  // Dedup: skip findings where an open record of same type+entity already exists
  const types = [...new Set(findings.map(f => f.findingType))]
  const { data: existing } = await supabase
    .from('audit_findings')
    .select('finding_type, entity_type, entity_id')
    .in('finding_type', types)
    .eq('status', 'open')

  const existingSet = new Set(
    (existing ?? []).map(e => `${e.finding_type}:${e.entity_type}:${e.entity_id ?? ''}`)
  )
  const dedupedFindings = findings.filter(f =>
    !existingSet.has(`${f.findingType}:${f.entityType}:${f.entityId ?? ''}`)
  )
  if (dedupedFindings.length === 0) return []

  const rows = dedupedFindings.map((f) => ({
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
 * Run all 11 audit checks. Returns combined findings.
 */
export async function runFullAudit(db?: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db ?? await createClient()
  const results = await Promise.all([
    auditDuplicatePayments(supabase),
    auditAmountMismatches(supabase),
    auditMissingVouchers(supabase),
    auditTimingAnomalies(supabase),
    auditMarginOutliers(supabase),
    auditOrphanedPayments(supabase),
    auditOverdueCollections(supabase),
    auditOverduePayables(supabase),
    auditDuplicateReceipts(supabase),
    auditUnmatchedReceipts(supabase),
    auditFrozenEntityActivity(supabase),
  ])
  return results.flat()
}

/**
 * Check 1: Duplicate payments — same supplier + same amount within 7 days.
 */
export async function auditDuplicatePayments(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
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

  return insertFindings(supabase, findings)
}

/**
 * Check 2: Amount mismatches — invoice total vs budget >15% variance.
 */
export async function auditAmountMismatches(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
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

  return insertFindings(supabase, findings)
}

/**
 * Check 3: Missing vouchers — confirmed settlements without journal entries.
 */
export async function auditMissingVouchers(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
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

  return insertFindings(supabase, findings)
}

/**
 * Check 4: Timing anomalies — invoices dated before the order date.
 */
export async function auditTimingAnomalies(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
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

  return insertFindings(supabase, findings)
}

/**
 * Check 5: Margin outliers — orders with margin <5% or >50%.
 */
export async function auditMarginOutliers(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
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

  return insertFindings(supabase, findings)
}

/**
 * Check 6: Orphaned payments — payable_records without matching budget_orders.
 */
export async function auditOrphanedPayments(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
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

  return insertFindings(supabase, findings)
}

/**
 * Check 7: Overdue collections — AR outstanding >60 days.
 */
export async function auditOverdueCollections(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
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

  return insertFindings(supabase, findings)
}

/**
 * Check 8: 应付逾期 — payable_records 未付且已过到期日。
 */
export async function auditOverduePayables(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
  const today = bizToday()
  const { data: payables } = await supabase
    .from('payable_records')
    .select('id, order_no, supplier_name, amount, currency, due_date, payment_status')
    .in('payment_status', ['unpaid', 'pending_approval', 'approved'])
    .not('due_date', 'is', null)
    .lt('due_date', today)

  if (!payables?.length) return []
  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []
  for (const p of payables) {
    const overdueDays = Math.floor((new Date(today).getTime() - new Date(p.due_date as string).getTime()) / 86400000)
    findings.push({
      findingType: 'overdue_payable',
      severity: overdueDays > 30 ? 'critical' : 'warning',
      entityType: 'payable_record',
      entityId: p.id as string,
      title: `应付逾期: ${p.supplier_name}`,
      description: `供应商"${p.supplier_name}"应付${p.currency} ${p.amount}已逾期${overdueDays}天(到期日${p.due_date})未付`,
      evidence: { orderNo: p.order_no, supplier: p.supplier_name, amount: p.amount, currency: p.currency, dueDate: p.due_date, overdueDays },
      status: 'open',
    })
  }
  return insertFindings(supabase, findings)
}

/**
 * Check 9: 重复回款 — 同客户 + 同金额 + 同参考号/同日，疑似一笔录两次。
 */
export async function auditDuplicateReceipts(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
  const { data: receipts } = await supabase
    .from('receivable_payments')
    .select('id, customer_name, amount_cny, payment_reference, received_at')
    .is('voided_at', null)
    .order('received_at', { ascending: true })

  if (!receipts?.length) return []
  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []
  const seen = new Map<string, Record<string, unknown>>()
  for (const r of receipts) {
    const ref = ((r.payment_reference as string) || '').trim()
    const day = String(r.received_at || '').slice(0, 10)
    const key = `${((r.customer_name as string) || '').trim()}|${r.amount_cny}|${ref || day}`
    const prev = seen.get(key)
    if (prev) {
      findings.push({
        findingType: 'duplicate_receipt',
        severity: 'critical',
        entityType: 'receivable_payment',
        entityId: r.id as string,
        title: `疑似重复回款: ${r.customer_name}`,
        description: `客户"${r.customer_name}"出现两笔相同金额(¥${r.amount_cny})${ref ? `、相同水单号(${ref})` : '、同日'}的回款记录`,
        evidence: { recordA: prev, recordB: { id: r.id, amount: r.amount_cny, ref, date: r.received_at } },
        status: 'open',
      })
    } else { seen.set(key, { id: r.id, amount: r.amount_cny, ref, date: r.received_at }) }
  }
  return insertFindings(supabase, findings)
}

/**
 * Check 10: 回款未匹配 — 回款流水剩余未分配金额 > 0 且超 7 天。
 */
export async function auditUnmatchedReceipts(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
  const [{ data: receipts }, { data: allocs }] = await Promise.all([
    supabase.from('receivable_payments').select('id, customer_name, amount_cny, received_at, created_at').is('voided_at', null),
    supabase.from('receivable_payment_allocations').select('payment_id, amount_cny').is('voided_at', null),
  ])
  if (!receipts?.length) return []
  const allocByPayment = new Map<string, number>()
  ;(allocs || []).forEach(a => {
    const k = a.payment_id as string
    allocByPayment.set(k, (allocByPayment.get(k) || 0) + (Number(a.amount_cny) || 0))
  })
  const now = Date.now()
  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []
  for (const p of receipts) {
    const remaining = (Number(p.amount_cny) || 0) - (allocByPayment.get(p.id as string) || 0)
    const ageDays = (now - new Date((p.received_at || p.created_at) as string).getTime()) / 86400000
    if (remaining > 0.005 && ageDays > 7) {
      findings.push({
        findingType: 'unmatched_receipt',
        severity: 'warning',
        entityType: 'receivable_payment',
        entityId: p.id as string,
        title: `回款未匹配: ${p.customer_name || '未知客户'}`,
        description: `回款¥${p.amount_cny}已${Math.floor(ageDays)}天未匹配完，剩余¥${Math.round(remaining * 100) / 100}未分配到订单`,
        evidence: { customer: p.customer_name, amountCny: p.amount_cny, remaining: Math.round(remaining * 100) / 100, ageDays: Math.floor(ageDays) },
        status: 'open',
      })
    }
  }
  return insertFindings(supabase, findings)
}

/**
 * Check 11: 冻结对象异常活动 — 实体被冻结(active)但近期仍有时间线变更。
 */
export async function auditFrozenEntityActivity(db: SupabaseClient): Promise<AuditFinding[]> {
  const supabase = db
  const { data: freezes } = await supabase
    .from('entity_freezes')
    .select('entity_type, entity_id, freeze_type, frozen_at')
    .eq('status', 'frozen')
  if (!freezes?.length) return []
  const findings: Omit<AuditFinding, 'id' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote' | 'createdAt'>[] = []
  for (const f of freezes) {
    const { data: events } = await supabase
      .from('entity_timeline')
      .select('id, event_type, event_title, created_at')
      .eq('entity_type', f.entity_type as string).eq('entity_id', f.entity_id as string)
      .gt('created_at', f.frozen_at as string)
      .not('event_type', 'in', '("freeze","unfreeze","frozen","audit")')
      .order('created_at', { ascending: false }).limit(5)
    if (events && events.length > 0) {
      findings.push({
        findingType: 'frozen_entity_activity',
        severity: 'critical',
        entityType: f.entity_type as string,
        entityId: f.entity_id as string,
        title: `冻结对象仍被操作: ${f.entity_type}/${f.entity_id}`,
        description: `该对象已冻结(${f.freeze_type})，但冻结后仍有${events.length}条变更，存在绕过冻结的风险`,
        evidence: { freezeType: f.freeze_type, frozenAt: f.frozen_at, recentEvents: events },
        status: 'open',
      })
    }
  }
  return insertFindings(supabase, findings)
}

/**
 * Resolve an audit finding with notes.
 */
export async function resolveAuditFinding(
  findingId: string,
  resolution: string,
  resolvedBy: string
): Promise<void> {
  const supabase = await createClient()

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
 * 认领异常（→ investigating），记录认领人。仅 open 状态可认领。
 */
export async function claimAuditFinding(findingId: string, actorId: string): Promise<void> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('audit_findings')
    .update({ status: 'investigating', assigned_to: actorId, assigned_at: new Date().toISOString() })
    .eq('id', findingId).eq('status', 'open')
    .select('id')
  if (error) throw new Error(`认领失败: ${error.message}`)
  if (!data || data.length === 0) throw new Error('该异常已被认领或已处理，请刷新')
}

/**
 * 忽略异常（→ dismissed），必须填写原因（审计留痕）。
 */
export async function dismissAuditFinding(findingId: string, reason: string, actorId: string): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('audit_findings')
    .update({ status: 'dismissed', resolution_note: reason, resolved_by: actorId, resolved_at: new Date().toISOString() })
    .eq('id', findingId)
    .in('status', ['open', 'investigating'])
  if (error) throw new Error(`忽略失败: ${error.message}`)
}

/**
 * Query audit findings with optional filters.
 */
export async function getAuditFindings(filters?: {
  status?: string
  severity?: string
  entityType?: string
}): Promise<AuditFinding[]> {
  const supabase = await createClient()

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
