// ============================================================
// 企业微信通知模板 — 财务Agent专用
// L1普通→L4严重 四级推送
// ============================================================

import { sendTextCardMessage, sendMarkdownMessage, sendToAll, isWecomConfigured } from './client'

const SYSTEM_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://finance-system-seven.vercel.app'

type NotifyLevel = 'L1' | 'L2' | 'L3' | 'L4'

// --- 通用通知发送 ---
async function notify(level: NotifyLevel, params: {
  title: string
  description: string
  link?: string
  responsible?: string    // 负责人企业微信ID
  manager?: string        // 主管企业微信ID
  ceo?: string            // CEO企业微信ID
}) {
  if (!isWecomConfigured()) {
    console.log(`[WeChat] Skip (not configured): ${params.title}`)
    return
  }

  const url = params.link || SYSTEM_URL
  const recipients: string[] = []

  if (params.responsible) recipients.push(params.responsible)
  if ((level === 'L2' || level === 'L3' || level === 'L4') && params.manager) {
    recipients.push(params.manager)
  }
  if ((level === 'L3' || level === 'L4') && params.ceo) {
    recipients.push(params.ceo)
  }

  // L4: 全员通知
  if (level === 'L4') {
    await sendToAll(`🚨 ${params.title}`, params.description, url)
    return
  }

  if (recipients.length === 0) return

  await sendTextCardMessage({
    touser: recipients.join('|'),
    title: params.title,
    description: params.description,
    url,
  })
}

// ============================================================
// 财务通知模板
// ============================================================

/** 回款提醒 */
export async function notifyCollectionReminder(params: {
  customer: string
  orderNo: string
  amount: number
  currency: string
  overdueDays: number
  salesUserId?: string
  ceoUserId?: string
}) {
  const level: NotifyLevel = params.overdueDays > 60 ? 'L3' : params.overdueDays > 30 ? 'L2' : 'L1'
  const urgency = params.overdueDays > 60 ? '🔴 严重逾期' : params.overdueDays > 30 ? '🟡 逾期' : '⏰ 即将到期'

  await notify(level, {
    title: `【回款提醒】${params.customer}`,
    description: `${urgency}\n订单: ${params.orderNo}\n未回款: ${params.currency} ${params.amount.toLocaleString()}\n${params.overdueDays > 0 ? `已逾期: ${params.overdueDays}天` : '7天内到期'}\n建议: ${params.overdueDays > 30 ? '立即催款，考虑暂停出货' : '跟进催款'}`,
    link: `${SYSTEM_URL}/receivables`,
    responsible: params.salesUserId,
    ceo: params.ceoUserId,
  })
}

/** 付款提醒 */
export async function notifyPaymentReminder(params: {
  supplier: string
  amount: number
  currency: string
  dueDate: string
  affectsProduction: boolean
  financeUserId?: string
  ceoUserId?: string
}) {
  const level: NotifyLevel = params.affectsProduction ? 'L2' : 'L1'

  await notify(level, {
    title: `【付款提醒】${params.supplier}`,
    description: `应付款: ${params.currency} ${params.amount.toLocaleString()}\n到期: ${params.dueDate}\n${params.affectsProduction ? '⚠️ 影响生产进度' : ''}`,
    link: `${SYSTEM_URL}/costs`,
    responsible: params.financeUserId,
    ceo: params.ceoUserId,
  })
}

/** 风险预警 */
export async function notifyRiskAlert(params: {
  title: string
  riskLevel: 'red' | 'yellow' | 'green'
  description: string
  suggestion: string
  financeUserId?: string
  ceoUserId?: string
}) {
  const level: NotifyLevel = params.riskLevel === 'red' ? 'L3' : 'L2'
  const icon = params.riskLevel === 'red' ? '🔴' : '🟡'

  await notify(level, {
    title: `${icon} ${params.title}`,
    description: `${params.description}\n建议: ${params.suggestion}`,
    link: `${SYSTEM_URL}/risks`,
    responsible: params.financeUserId,
    ceo: params.ceoUserId,
  })
}

/** 熔断通知（L4严重，通知CEO） */
export async function notifyCircuitBreaker(params: {
  customer: string
  trigger: string
  description: string
  actions: string[]
  ceoUserId?: string
}) {
  const actionText = params.actions.map((a, i) => `${i + 1}. ${a}`).join('\n')

  // 用Markdown给CEO发送详细信息
  if (params.ceoUserId && isWecomConfigured()) {
    await sendMarkdownMessage({
      touser: params.ceoUserId,
      content: `# 🚨 财务熔断预警\n\n**客户:** ${params.customer}\n**触发:** ${params.trigger}\n**详情:** ${params.description}\n\n**建议操作:**\n${actionText}\n\n> 请在[财务系统](${SYSTEM_URL}/risks)中确认操作`,
    })
  }

  // 同时群通知
  await notify('L4', {
    title: `🚨 熔断预警: ${params.customer}`,
    description: `${params.description}\n需CEO确认后执行`,
    link: `${SYSTEM_URL}/risks`,
    ceo: params.ceoUserId,
  })
}

/** 审批通知 */
export async function notifyApprovalRequest(params: {
  orderNo: string
  customer: string
  amount: number
  currency: string
  margin: number
  reason: string
  approverUserId: string
}) {
  await sendTextCardMessage({
    touser: params.approverUserId,
    title: `【待审批】${params.orderNo}`,
    description: `客户: ${params.customer}\n金额: ${params.currency} ${params.amount.toLocaleString()}\n毛利率: ${params.margin}%\n${params.reason}`,
    url: `${SYSTEM_URL}/approvals`,
    btntxt: '去审批',
  })
}

/** 老板日报 */
export async function notifyDailyDigest(params: {
  cashBalance: number
  todayInflow: number
  todayOutflow: number
  pendingApprovals: number
  riskCount: number
  topIssue: string
  ceoUserId: string
}) {
  if (!isWecomConfigured()) return

  await sendMarkdownMessage({
    touser: params.ceoUserId,
    content: `# 📊 财务日报\n\n`
      + `**现金余额:** $${params.cashBalance.toLocaleString()}\n`
      + `**今日收入:** $${params.todayInflow.toLocaleString()}\n`
      + `**今日支出:** $${params.todayOutflow.toLocaleString()}\n`
      + `**待审批:** ${params.pendingApprovals}笔\n`
      + `**活跃风险:** ${params.riskCount}项\n\n`
      + `**最需关注:** ${params.topIssue}\n\n`
      + `> [查看详情](${SYSTEM_URL}/dashboard/boss)`,
  })
}
