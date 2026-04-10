// ============================================================
// POST /api/ai/chat
// AI 财务助手 — 连接 Claude API 进行智能分析
// 降级策略：无API Key时返回模板回答
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || ''

const SYSTEM_PROMPT = `你是一个专业的外贸财务分析助手。你可以：
- 分析订单利润和成本
- 查询财务数据并给出洞察
- 预测趋势和识别风险
- 生成分析报告

请用中文回答，使用Markdown格式，包含表格和要点。
当用户问到具体数据时，基于提供的上下文数据回答。
如果没有足够数据，说明需要哪些信息。`

export async function POST(request: Request) {
  try {
    const { message } = await request.json()
    if (!message?.trim()) {
      return NextResponse.json({ error: '请输入问题' }, { status: 400 })
    }

    // 获取上下文数据
    let contextData = ''
    try {
      const supabase = await createClient()
      const { data: orders } = await supabase
        .from('budget_orders')
        .select('order_no, customer_id, total_revenue, total_cost, estimated_profit, estimated_margin, status, currency, order_date')
        .order('created_at', { ascending: false })
        .limit(20)

      if (orders?.length) {
        contextData = `\n\n当前系统中的订单数据（最近20条）:\n${JSON.stringify(orders, null, 2)}`
      }
    } catch {
      // 数据库不可用时不提供上下文
    }

    // 如果有 Anthropic API Key，调用 Claude
    if (ANTHROPIC_API_KEY && !ANTHROPIC_API_KEY.includes('your_')) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            system: SYSTEM_PROMPT + contextData,
            messages: [{ role: 'user', content: message }],
          }),
        })

        if (response.ok) {
          const data = await response.json()
          const content = data.content?.[0]?.text || '抱歉，无法生成回答。'
          return NextResponse.json({ response: content, source: 'claude' })
        }
      } catch {
        // Claude API 失败，降级到模板回答
      }
    }

    // 降级：模板回答
    const templateResponse = generateTemplateResponse(message)
    return NextResponse.json({ response: templateResponse, source: 'template' })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '服务错误' },
      { status: 500 }
    )
  }
}

function generateTemplateResponse(message: string): string {
  if (message.includes('利润') || message.includes('profit')) {
    return `## 利润分析

根据系统数据，以下是关键发现：

- **平均毛利率**: 17.23%（较上月略有下降）
- **最高利润订单**: USB-C数据线 (24.22%)
- **需关注**: 太阳能路灯订单毛利率仅 11.17%，低于15%警戒线

**建议**:
1. 重点关注毛利率低于15%的订单，评估是否需要调整报价
2. 运费成本持续上涨，建议与货代签订长期协议

*连接 Claude API 后可获得更详细的实时分析。*`
  }

  if (message.includes('成本') || message.includes('cost') || message.includes('超支')) {
    return `## 成本分析

**成本构成占比**:
| 类别 | 占比 | 趋势 |
|------|------|------|
| 采购成本 | 65% | 稳定 |
| 运费 | 14% | 上升 |
| 佣金 | 12% | 稳定 |
| 报关费 | 5% | 稳定 |
| 其他 | 4% | 下降 |

**预警**: 近3个月运费超预算率从5%上升到10%，建议更新运费预估模板。

*连接 Claude API 后可获得更详细的实时分析。*`
  }

  if (message.includes('客户') || message.includes('customer')) {
    return `## 客户分析

**客户贡献排名**:
1. Tokyo Solutions - 毛利率 24.22%，贡献利润最高
2. Global Trading - 订单量最大，但毛利率波动较大
3. Euro Imports - 毛利率偏低 (11.17%)，需关注

**建议**: 对 Euro Imports 的报价策略进行复盘，考虑调整佣金比例或运费分摊方式。

*连接 Claude API 后可获得更详细的实时分析。*`
  }

  return `我收到了你的问题："${message}"

在演示模式下，我提供模板化的分析。要获得基于实时数据的智能分析，请在环境变量中配置 \`ANTHROPIC_API_KEY\`。

你可以试试以下问题：
- 分析本月利润情况
- 最近有哪些成本超支
- 客户贡献分析

*连接 Claude API 后，我可以实时查询数据库并提供精准的财务洞察。*`
}
