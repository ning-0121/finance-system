// ============================================================
// 企业微信待办同步 — 系统待办 → 企微待办
// ============================================================

import { getAccessToken } from './client'

const BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin'
const SYSTEM_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://finance-system-seven.vercel.app'

/** 创建企微待办 */
export async function createWecomTodo(params: {
  creatorId: string       // 创建者企微userId
  assigneeIds: string[]   // 执行者企微userId列表
  title: string
  description?: string
  url?: string            // 点击跳转链接
  dueTime?: number        // 截止时间戳(秒)
}): Promise<{ taskId: string; error?: string }> {
  try {
    const token = await getAccessToken()
    const res = await fetch(`${BASE_URL}/wedrive/task/create?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creator_userid: params.creatorId,
        tasklist: params.assigneeIds.map(uid => ({
          userid: uid,
          title: params.title,
          description: params.description || '',
          url: params.url || SYSTEM_URL,
          due_time: params.dueTime || 0,
        })),
      }),
    })
    const data = await res.json()
    if (data.errcode !== 0) return { taskId: '', error: data.errmsg }
    return { taskId: data.task_id || 'created' }
  } catch (e) {
    return { taskId: '', error: e instanceof Error ? e.message : 'Failed' }
  }
}

// --- 财务待办模板 ---

/** 创建审批待办 */
export async function createApprovalTodo(params: {
  approverUserId: string
  orderNo: string
  customer: string
  amount: number
  currency: string
}) {
  return createWecomTodo({
    creatorId: 'system',
    assigneeIds: [params.approverUserId],
    title: `待审批: ${params.orderNo}`,
    description: `客户: ${params.customer}, 金额: ${params.currency} ${params.amount.toLocaleString()}`,
    url: `${SYSTEM_URL}/approvals`,
  })
}

/** 创建催款待办 */
export async function createCollectionTodo(params: {
  salesUserId: string
  customer: string
  amount: number
  overdueDays: number
}) {
  return createWecomTodo({
    creatorId: 'system',
    assigneeIds: [params.salesUserId],
    title: `催款: ${params.customer} 逾期${params.overdueDays}天`,
    description: `待回款: $${params.amount.toLocaleString()}`,
    url: `${SYSTEM_URL}/receivables`,
  })
}

/** 创建付款待办 */
export async function createPaymentTodo(params: {
  financeUserId: string
  supplier: string
  amount: number
  dueDate: string
}) {
  return createWecomTodo({
    creatorId: 'system',
    assigneeIds: [params.financeUserId],
    title: `付款: ${params.supplier}`,
    description: `金额: ¥${params.amount.toLocaleString()}, 到期: ${params.dueDate}`,
    url: `${SYSTEM_URL}/costs`,
  })
}
