// ============================================================
// 企业微信 API 客户端 — Token管理 + 基础请求
// ============================================================

const CORP_ID = process.env.WECOM_CORP_ID || ''
const CORP_SECRET = process.env.WECOM_CORP_SECRET || ''
const AGENT_ID = process.env.WECOM_AGENT_ID || ''

const BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin'

// Token缓存（内存级，Vercel serverless每实例独立）
let tokenCache: { token: string; expiresAt: number } | null = null

// --- 获取 access_token（自动缓存） ---
export async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token
  }

  if (!CORP_ID || !CORP_SECRET) {
    throw new Error('WECOM_CORP_ID or WECOM_CORP_SECRET not configured')
  }

  const res = await fetch(
    `${BASE_URL}/gettoken?corpid=${CORP_ID}&corpsecret=${CORP_SECRET}`
  )
  const data = await res.json()

  if (data.errcode !== 0) {
    throw new Error(`WeChat token error: ${data.errmsg}`)
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000, // 提前5分钟过期
  }

  return tokenCache.token
}

// --- 通用API请求 ---
async function wecomRequest(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await getAccessToken()
  const url = `${BASE_URL}${path}?access_token=${token}`

  const res = await fetch(url, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined)

  const data = await res.json()
  if (data.errcode !== 0) {
    console.error(`[WeChat] API error: ${path}`, data)
  }
  return data
}

// ============================================================
// 消息推送
// ============================================================

/** 发送文本卡片消息 */
export async function sendTextCardMessage(params: {
  touser: string        // 用户ID列表，|分隔
  title: string
  description: string
  url: string           // 点击跳转链接
  btntxt?: string       // 按钮文字
}) {
  return wecomRequest('/message/send', {
    touser: params.touser,
    msgtype: 'textcard',
    agentid: Number(AGENT_ID),
    textcard: {
      title: params.title,
      description: params.description,
      url: params.url,
      btntxt: params.btntxt || '查看详情',
    },
  })
}

/** 发送Markdown消息（仅企业微信内可见） */
export async function sendMarkdownMessage(params: {
  touser: string
  content: string
}) {
  return wecomRequest('/message/send', {
    touser: params.touser,
    msgtype: 'markdown',
    agentid: Number(AGENT_ID),
    markdown: { content: params.content },
  })
}

/** 发送消息给所有人 */
export async function sendToAll(title: string, description: string, url: string) {
  return wecomRequest('/message/send', {
    touser: '@all',
    msgtype: 'textcard',
    agentid: Number(AGENT_ID),
    textcard: { title, description, url, btntxt: '查看详情' },
  })
}

// ============================================================
// 组织架构同步
// ============================================================

/** 获取部门列表 */
export async function getDepartmentList() {
  return wecomRequest('/department/list')
}

/** 获取部门成员详情 */
export async function getDepartmentUsers(departmentId: number) {
  const token = await getAccessToken()
  const res = await fetch(
    `${BASE_URL}/user/list?access_token=${token}&department_id=${departmentId}`
  )
  return res.json()
}

/** 获取单个用户信息 */
export async function getUserInfo(userId: string) {
  const token = await getAccessToken()
  const res = await fetch(
    `${BASE_URL}/user/get?access_token=${token}&userid=${userId}`
  )
  return res.json()
}

// ============================================================
// OAuth扫码登录
// ============================================================

/** 生成企业微信OAuth授权URL */
export function getOAuthUrl(redirectUri: string, state = 'finance') {
  return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${CORP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_privateinfo&state=${state}&agentid=${AGENT_ID}#wechat_redirect`
}

/** 通过code获取用户身份 */
export async function getUserByCode(code: string) {
  const token = await getAccessToken()
  const res = await fetch(
    `${BASE_URL}/auth/getuserinfo?access_token=${token}&code=${code}`
  )
  return res.json()
}

// ============================================================
// 审批
// ============================================================

/** 发起审批 */
export async function createApproval(params: {
  creator_userid: string
  approver_userids: string[]
  template_id: string
  apply_data: Record<string, unknown>
  summary_list: { summary_info: { text: string; lang: string }[] }[]
}) {
  return wecomRequest('/oa/applyevent', {
    creator_userid: params.creator_userid,
    template_id: params.template_id,
    use_template_approver: 0,
    approver: [{ attr: 2, userid: params.approver_userids }],
    apply_data: params.apply_data,
    summary_list: params.summary_list,
  })
}

/** 查询审批详情 */
export async function getApprovalDetail(spNo: string) {
  return wecomRequest('/oa/getapprovaldetail', { sp_no: spNo })
}

// ============================================================
// 工具函数
// ============================================================

export function isWecomConfigured(): boolean {
  return !!CORP_ID && !!CORP_SECRET && !!AGENT_ID
}

export function getAgentId(): string {
  return AGENT_ID
}

export function getCorpId(): string {
  return CORP_ID
}
