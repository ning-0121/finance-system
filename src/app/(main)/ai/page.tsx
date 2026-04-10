'use client'

import { useState, useRef, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Bot, Send, User, Sparkles, TrendingUp, Search, AlertTriangle } from 'lucide-react'
import type { AIChatMessage } from '@/lib/types'

const quickActions = [
  { icon: TrendingUp, label: '本月利润分析', prompt: '分析本月的利润情况，哪些订单表现好，哪些需要关注？' },
  { icon: Search, label: '查询高毛利订单', prompt: '上个月毛利率最高的5个订单是哪些？' },
  { icon: AlertTriangle, label: '成本异常检查', prompt: '最近有哪些订单的实际成本超出预算？分析原因。' },
  { icon: Sparkles, label: '运费趋势预测', prompt: '根据历史数据，预测下个月的运费走势。' },
]

const demoResponses: Record<string, string> = {
  '分析本月的利润情况': `## 本月利润分析报告

**总体表现：**
- 本月总营收：$222,000
- 总利润：$38,255
- 平均毛利率：17.23%（较上月下降0.6个百分点）

**表现优秀的订单：**
1. **BO-202604-0003** (USB-C数据线) - 预计毛利率 24.22%，为本月最优
2. **BO-202604-0001** (LED产品) - 已确认毛利率 20.09%

**需要关注的订单：**
1. **BO-202604-0002** (太阳能路灯) - 毛利率仅 11.17%，低于15%警戒线
   - 建议：重新议价运费或提高报价
2. **BO-202603-0005** (LED灯带) - 实际亏损 $705
   - 原因：运费上涨16.67% + 采购成本上浮2.86%

**AI建议：**
- 关注运费波动，建议签订长期运输合同
- 太阳能路灯品类佣金占比较高，考虑优化渠道结构`,

  '上个月毛利率最高的5个订单': `## 上月高毛利率订单 TOP 5

| 排名 | 订单号 | 客户 | 产品 | 毛利率 | 利润 |
|------|--------|------|------|--------|------|
| 1 | BO-202603-0001 | ABC Corp | 电子配件 | 28.5% | $14,250 |
| 2 | BO-202603-0003 | DEF Ltd | LED灯带 | 25.2% | $11,340 |
| 3 | BO-202603-0007 | GHI Inc | USB产品 | 23.8% | $9,520 |
| 4 | BO-202603-0004 | JKL GmbH | 太阳能板 | 21.1% | $16,880 |
| 5 | BO-202603-0009 | MNO Corp | 传感器 | 19.6% | $7,840 |

**共性分析：** 高毛利订单主要集中在电子配件和LED品类，目标客户以北美市场为主。建议加大这些品类的市场推广。`,

  '最近有哪些订单的实际成本超出预算': `## 成本超支分析

**近期成本超标订单：**

### 1. BO-202603-0005 - 超支 4.64%
- 主要原因：运费暴涨 (+16.67%)
- 柜位紧张导致实际运费 $2,100 vs 预算 $1,800
- 最终亏损 $705

### 2. BO-202604-0001 - 超支 2.91%
- 采购成本上涨 3.16%（原材料涨价）
- 运费上浮 7.81%（旺季因素）
- 但报关费和包装费节省部分对冲

**趋势预警：**
- 近3个月运费超预算率从5%上升到10%
- 建议更新运费预估模板，将基准上调8-10%
- LED原材料价格处于上升通道，采购成本预估需增加3-5%余量`,
}

export default function AIPage() {
  const [messages, setMessages] = useState<AIChatMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: '你好！我是你的AI财务助手。我可以帮你：\n\n- 分析订单利润和成本\n- 查询财务数据\n- 预测趋势和风险\n- 生成分析报告\n\n有什么我可以帮你的？',
      timestamp: new Date().toISOString(),
    },
  ])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = async () => {
    if (!input.trim()) return

    const userMessage: AIChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setIsTyping(true)

    // Simulate AI response
    setTimeout(() => {
      const matchKey = Object.keys(demoResponses).find(key =>
        input.includes(key) || key.includes(input.slice(0, 10))
      )

      const responseContent = matchKey
        ? demoResponses[matchKey]
        : `我已收到你的问题："${input}"\n\n这是一个很好的问题。在实际系统中，我会连接数据库查询相关数据并给出详细分析。目前在演示模式下，你可以试试以下问题：\n\n- 分析本月的利润情况\n- 上个月毛利率最高的5个订单\n- 最近有哪些订单的成本超出预算`

      const aiMessage: AIChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: responseContent,
        timestamp: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, aiMessage])
      setIsTyping(false)
    }, 1500)
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="AI 财务助手" subtitle="智能分析、自然语言查询、预测预警" />

      <div className="flex-1 flex flex-col p-6 min-h-0">
        <div className="flex-1 flex gap-6 min-h-0">
          {/* Chat Area */}
          <Card className="flex-1 flex flex-col min-h-0">
            <ScrollArea className="flex-1 p-4" ref={scrollRef}>
              <div className="space-y-4 max-w-3xl mx-auto">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                    {msg.role === 'assistant' && (
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <Bot className="h-4 w-4 text-primary" />
                      </div>
                    )}
                    <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}>
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    </div>
                    {msg.role === 'user' && (
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                        <User className="h-4 w-4 text-blue-600" />
                      </div>
                    )}
                  </div>
                ))}
                {isTyping && (
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                    <div className="bg-muted rounded-2xl px-4 py-3">
                      <div className="flex gap-1">
                        <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" />
                        <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:0.1s]" />
                        <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:0.2s]" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Input */}
            <div className="border-t p-4">
              <form
                onSubmit={(e) => { e.preventDefault(); handleSend() }}
                className="flex gap-2 max-w-3xl mx-auto"
              >
                <Input
                  placeholder="问我任何财务相关的问题..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={isTyping}
                  className="flex-1"
                />
                <Button type="submit" disabled={!input.trim() || isTyping}>
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </div>
          </Card>

          {/* Quick Actions */}
          <div className="w-64 shrink-0 space-y-3 hidden xl:block">
            <h3 className="text-sm font-semibold text-muted-foreground">快捷操作</h3>
            {quickActions.map((action) => (
              <Card
                key={action.label}
                className="cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => {
                  setInput(action.prompt)
                }}
              >
                <CardContent className="p-3 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/5 flex items-center justify-center shrink-0">
                    <action.icon className="h-4 w-4 text-primary" />
                  </div>
                  <span className="text-sm">{action.label}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
