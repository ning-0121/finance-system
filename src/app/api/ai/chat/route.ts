// ============================================================
// POST /api/ai/chat
// AI 财务助手 — 智能查询 + 丰富上下文 + 流式响应降级
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

const SYSTEM_PROMPT = `你是绮陌服饰(QIMO Clothing)的AI财务分析助手。你可以帮财务总监Su和财务方圆：

## 你的能力
1. **订单分析**: 分析任何订单的利润、成本、毛利率
2. **客户分析**: 按客户汇总收入、利润、订单量、平均毛利率
3. **趋势分析**: 月度/季度营收利润趋势，同比环比
4. **风险预警**: 识别亏损订单、低毛利率订单、成本超支
5. **费用分析**: 各类费用(运费/佣金/报关费)的占比和趋势
6. **对比分析**: 预算vs实际差异分析，找出超支原因
7. **决策建议**: 基于数据给出定价、成本控制、客户策略建议
8. **情景模拟**: 回答"如果...会怎样"的假设性问题
9. **熔断判断**: 判断哪些客户应该停止赊账、暂停出货
10. **催款建议**: 生成催款优先级和英文催款邮件

## 情景模拟能力
当用户问"如果某客户少下单50%"、"如果原料涨价10%"等假设问题时：
- 基于当前数据计算影响
- 给出营收/利润/现金流的变化预测
- 列出最受影响的订单
- 给出应对建议

## 熔断判断能力
当用户问"哪些客户应该停止赊账"等问题时：
- 综合评估客户的逾期率、坏账评分、信用额度使用率
- 给出具体的客户名单和原因
- 推荐的行动（暂停出货/降低信用额度/要求预付款）

## 回答规范
- 用中文回答，Markdown格式
- 涉及金额时标明币种，保留2位小数
- 给出具体数据，不要笼统描述
- 提供可操作的建议，不只是描述现状
- 如果数据不足，说明需要哪些数据

## 当前系统数据
以下是系统中的实时数据，请基于这些数据回答：
`

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const { message } = await request.json()
    if (!message?.trim()) {
      return NextResponse.json({ error: '请输入问题' }, { status: 400 })
    }

    // 构建丰富的上下文数据
    const contextData = await buildContext(message)

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
            max_tokens: 4000,
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
        // Claude API 失败，降级
      }
    }

    // 降级：基于真实数据的模板回答
    const templateResponse = await generateDataDrivenResponse(message, contextData)
    return NextResponse.json({ response: templateResponse, source: 'template' })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '服务错误' },
      { status: 500 }
    )
  }
}

// --- 构建丰富的AI上下文 ---
async function buildContext(question: string): Promise<string> {
  const sections: string[] = []

  try {
    const supabase = await createClient()

    // 1. 订单汇总
    const { data: orders } = await supabase
      .from('budget_orders')
      .select('order_no, customer_id, total_revenue, total_cost, estimated_profit, estimated_margin, status, currency, order_date, created_at, customers(company, country)')
      .order('created_at', { ascending: false })
      .limit(50)

    if (orders?.length) {
      // 汇总统计
      const approved = orders.filter((o: Record<string, unknown>) => o.status === 'approved' || o.status === 'closed')
      const totalRevenue = approved.reduce((s: number, o: Record<string, unknown>) => s + (o.total_revenue as number || 0), 0)
      const totalProfit = approved.reduce((s: number, o: Record<string, unknown>) => s + (o.estimated_profit as number || 0), 0)
      const avgMargin = approved.length > 0
        ? approved.reduce((s: number, o: Record<string, unknown>) => s + (o.estimated_margin as number || 0), 0) / approved.length
        : 0

      sections.push(`### 订单概览
- 总订单数: ${orders.length}
- 已通过/关闭: ${approved.length}
- 总营收: $${totalRevenue.toLocaleString()}
- 总利润: $${totalProfit.toLocaleString()}
- 平均毛利率: ${avgMargin.toFixed(2)}%
- 亏损订单: ${orders.filter((o: Record<string, unknown>) => (o.estimated_profit as number) < 0).length} 笔`)

      // 按客户汇总
      const customerMap = new Map<string, { revenue: number; profit: number; count: number; country: string }>()
      for (const o of orders) {
        const cust = o.customers as unknown as Record<string, unknown> | null
        const name = (cust?.company as string) || '未知客户'
        const country = (cust?.country as string) || ''
        const existing = customerMap.get(name) || { revenue: 0, profit: 0, count: 0, country }
        existing.revenue += (o.total_revenue as number) || 0
        existing.profit += (o.estimated_profit as number) || 0
        existing.count++
        customerMap.set(name, existing)
      }

      sections.push(`### 客户分析
${Array.from(customerMap.entries())
  .sort((a, b) => b[1].revenue - a[1].revenue)
  .map(([name, data]) => `- ${name}(${data.country}): ${data.count}单, 营收$${data.revenue.toLocaleString()}, 利润$${data.profit.toLocaleString()}, 毛利率${data.revenue > 0 ? ((data.profit / data.revenue) * 100).toFixed(1) : 0}%`)
  .join('\n')}`)

      // 按状态分布
      const statusDist = orders.reduce((acc: Record<string, number>, o: Record<string, unknown>) => {
        acc[o.status as string] = (acc[o.status as string] || 0) + 1
        return acc
      }, {})
      sections.push(`### 订单状态分布
${Object.entries(statusDist).map(([s, c]) => `- ${s}: ${c}笔`).join('\n')}`)

      // 最近订单明细（如果问题涉及具体订单）
      if (question.includes('订单') || question.includes('order') || question.includes('最近')) {
        sections.push(`### 最近订单明细
${orders.slice(0, 10).map((o: Record<string, unknown>) => {
  const cust = o.customers as Record<string, unknown> | null
  return `- ${o.order_no} | ${(cust?.company as string) || ''} | ${o.currency} ${(o.total_revenue as number || 0).toLocaleString()} | 利润 ${(o.estimated_profit as number || 0).toLocaleString()} | 毛利率 ${o.estimated_margin}% | ${o.status}`
}).join('\n')}`)
      }
    }

    // 2. 费用数据（如果问题涉及费用/成本）
    if (question.includes('费用') || question.includes('成本') || question.includes('cost') || question.includes('运费') || question.includes('佣金')) {
      const { data: costs } = await supabase
        .from('cost_items')
        .select('cost_type, amount, currency, description, created_at')
        .order('created_at', { ascending: false })
        .limit(100)

      if (costs?.length) {
        const byType = costs.reduce((acc: Record<string, { count: number; total: number }>, c: Record<string, unknown>) => {
          const type = c.cost_type as string
          if (!acc[type]) acc[type] = { count: 0, total: 0 }
          acc[type].count++
          acc[type].total += c.amount as number
          return acc
        }, {})

        sections.push(`### 费用汇总
${Object.entries(byType).map(([type, data]) => `- ${type}: ${data.count}笔, 合计$${data.total.toLocaleString()}`).join('\n')}`)
      }
    }

    // 3. 预警信息 + 风险事件
    if (question.includes('预警') || question.includes('风险') || question.includes('异常') || question.includes('停止') || question.includes('赊账') || question.includes('熔断') || question.includes('暂停')) {
      const { data: risks } = await supabase
        .from('financial_risk_events')
        .select('risk_type, risk_level, title, description, suggested_action, status')
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(20)

      if (risks?.length) {
        sections.push(`### 活跃风险事件 (${risks.length}条)
${risks.map((r: Record<string, unknown>) => `- [${r.risk_level}] ${r.title}: ${r.description}\n  建议: ${r.suggested_action || '无'}`).join('\n')}`)
      }
    }

    // 4. 客户画像（情景模拟/赊账/信用相关问题）
    if (question.includes('客户') || question.includes('赊账') || question.includes('信用') || question.includes('如果') || question.includes('停止') || question.includes('催款')) {
      const { data: profiles } = await supabase
        .from('customer_financial_profiles')
        .select('customer_name, risk_level, avg_payment_days, overdue_rate, total_outstanding, credit_limit, bad_debt_score, dependency_score, average_order_profit_rate')
        .order('risk_level')

      if (profiles?.length) {
        sections.push(`### 客户财务画像
${profiles.map((p: Record<string, unknown>) => `- ${p.customer_name} [${p.risk_level}级] 付款${p.avg_payment_days}天, 逾期率${((p.overdue_rate as number) * 100).toFixed(0)}%, 欠款$${(p.total_outstanding as number || 0).toLocaleString()}, 坏账分${p.bad_debt_score}, 利润率${p.average_order_profit_rate}%`).join('\n')}`)
      }
    }

    // 5. 供应商画像
    if (question.includes('供应商') || question.includes('付款') || question.includes('延迟') || question.includes('断供')) {
      const { data: suppliers } = await supabase
        .from('supplier_financial_profiles')
        .select('supplier_name, risk_level, avg_payment_term_days, historical_stop_supply_count, urgency_score, current_outstanding, next_due_date')
        .order('urgency_score', { ascending: false })

      if (suppliers?.length) {
        sections.push(`### 供应商画像
${suppliers.map((s: Record<string, unknown>) => `- ${s.supplier_name} [${s.risk_level}级] 账期${s.avg_payment_term_days}天, 断供${s.historical_stop_supply_count}次, 紧迫度${s.urgency_score}, 待付¥${(s.current_outstanding as number || 0).toLocaleString()}`).join('\n')}`)
      }
    }

    // 6. 现金流数据
    if (question.includes('现金') || question.includes('资金') || question.includes('如果') || question.includes('缺口')) {
      const { data: cashflow } = await supabase
        .from('cashflow_forecasts')
        .select('forecast_date, expected_inflow, expected_outflow, expected_cash_balance, warning_level, scenario')
        .eq('scenario', 'normal')
        .order('forecast_date')
        .limit(14)

      if (cashflow?.length) {
        sections.push(`### 现金流预测
${cashflow.map((c: Record<string, unknown>) => `- ${c.forecast_date}: 入${c.expected_inflow} 出${c.expected_outflow} 余额${c.expected_cash_balance} [${c.warning_level}]`).join('\n')}`)
      }
    }
  } catch {
    sections.push('（数据库查询失败，使用有限数据回答）')
  }

  return sections.length > 0 ? '\n' + sections.join('\n\n') : '\n（暂无数据）'
}

// --- 基于真实数据的模板回答 ---
async function generateDataDrivenResponse(message: string, context: string): Promise<string> {
  // 提取上下文中的关键数据
  const hasData = !context.includes('暂无数据')

  if (message.includes('利润') || message.includes('profit')) {
    return `## 利润分析

${hasData ? context : '暂无订单数据。请先录入订单信息。'}

**建议操作：**
1. 重点关注毛利率低于15%的订单
2. 分析运费上涨是否影响整体利润
3. 对亏损订单进行复盘

*配置 ANTHROPIC_API_KEY 后可获得更深度的AI分析。*`
  }

  if (message.includes('客户') || message.includes('customer')) {
    return `## 客户分析

${hasData ? context : '暂无客户数据。请先录入订单信息。'}

**建议操作：**
1. 对高利润客户加大投入
2. 对低毛利率客户评估调价空间
3. 关注新客户的信用风险

*配置 ANTHROPIC_API_KEY 后可获得更深度的AI分析。*`
  }

  if (message.includes('费用') || message.includes('成本') || message.includes('cost')) {
    return `## 费用/成本分析

${hasData ? context : '暂无费用数据。请先在费用归集模块录入数据。'}

**建议操作：**
1. 检查运费是否有优化空间（签长期合同）
2. 评估佣金比例是否合理
3. 关注未归集费用

*配置 ANTHROPIC_API_KEY 后可获得更深度的AI分析。*`
  }

  return `我收到了你的问题："${message}"

${hasData ? '以下是系统中的相关数据：\n' + context : '系统中暂无数据。'}

你可以问我：
- **利润分析**: "本月利润情况"、"哪些订单亏损"
- **客户分析**: "客户贡献排名"、"哪个客户毛利率最高"
- **费用分析**: "运费占比多少"、"费用趋势"
- **风险预警**: "有哪些异常"、"哪些订单超支"

*配置 \`ANTHROPIC_API_KEY\` 环境变量后，可获得基于Claude的深度智能分析。*`
}
