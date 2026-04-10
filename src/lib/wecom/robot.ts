// ============================================================
// 企业微信群机器人 — 群消息推送
// 无需IP白名单，Webhook方式
// ============================================================

const WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || ''

/** 发送文本消息到群 */
export async function sendGroupText(content: string, mentionedList?: string[]): Promise<boolean> {
  if (!WEBHOOK_URL) return false
  try {
    const body: Record<string, unknown> = {
      msgtype: 'text',
      text: {
        content,
        mentioned_list: mentionedList || [],
      },
    }
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return data.errcode === 0
  } catch {
    return false
  }
}

/** 发送Markdown消息到群 */
export async function sendGroupMarkdown(content: string): Promise<boolean> {
  if (!WEBHOOK_URL) return false
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    })
    const data = await res.json()
    return data.errcode === 0
  } catch {
    return false
  }
}

// --- 财务群消息模板 ---

/** 日报推送到群 */
export async function pushDailyDigestToGroup(params: {
  cashBalance: number
  weekInflow: number
  weekOutflow: number
  riskCount: number
  pendingApprovals: number
  topIssue: string
}): Promise<boolean> {
  return sendGroupMarkdown(
    `# 📊 财务日报 (${new Date().toLocaleDateString('zh-CN')})\n\n`
    + `> 💰 现金余额: **$${params.cashBalance.toLocaleString()}**\n`
    + `> 📈 本周收入: $${params.weekInflow.toLocaleString()}\n`
    + `> 📉 本周支出: $${params.weekOutflow.toLocaleString()}\n`
    + `> ⚠️ 活跃风险: ${params.riskCount}项\n`
    + `> 📋 待审批: ${params.pendingApprovals}笔\n\n`
    + `**最需关注:** ${params.topIssue}`
  )
}

/** 风险预警推送到群 */
export async function pushRiskAlertToGroup(params: {
  level: 'red' | 'yellow'
  title: string
  description: string
  action: string
  mentionUsers?: string[]
}): Promise<boolean> {
  const icon = params.level === 'red' ? '🔴' : '🟡'
  const sent = await sendGroupMarkdown(
    `# ${icon} ${params.title}\n\n${params.description}\n\n**建议:** ${params.action}`
  )
  // 红色风险额外@相关人
  if (params.level === 'red' && params.mentionUsers?.length) {
    await sendGroupText(`⚠️ ${params.title} — 请立即处理`, params.mentionUsers)
  }
  return sent
}

/** 熔断预警推送到群 */
export async function pushCircuitBreakerToGroup(customer: string, reason: string, actions: string[]): Promise<boolean> {
  return sendGroupMarkdown(
    `# 🚨 财务熔断预警\n\n`
    + `**客户:** ${customer}\n`
    + `**原因:** ${reason}\n\n`
    + `**建议操作:**\n${actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n`
    + `> 需CEO确认后执行，请在系统中操作`
  )
}
