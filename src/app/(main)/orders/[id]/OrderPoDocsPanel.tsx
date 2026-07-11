'use client'

// ============================================================
// 订单级 PO 审批面板 —— 客户PO单据 + 内部报价单(2026-07-11 老板对齐:
// "PO审批"=客户PO、业务执行第一节点;财务核 PO 价格/总额 + 预算利润达标 → 预算审批通过即完成)
// 附件按 related_qimo_order_id 关联;识别是 AI 只读建议,预填须人确认(铁律)。
// 挂两处:订单详情(可预填成本)、审批队列弹窗(只读核对)。
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, Paperclip, Sparkles, FileText, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  getOrderAttachments, extractQuote, BUCKET_LABELS,
  type PoAttachment, type QuoteResultUI, type QuoteCostLineUI,
} from '@/lib/supabase/purchase-approvals'
import { openAttachment } from '@/lib/supabase/storage'

const money = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 }))
const r2 = (n: number) => Math.round(n * 100) / 100

export function OrderPoDocsPanel({ qimoOrderId, budget, quantity, onPrefillCosts }: {
  qimoOrderId: string | null | undefined
  /** 预算侧数字(对照用):收入(原币)/币种/成本合计(CNY)/毛利率 */
  budget?: { revenue?: number | null; currency?: string | null; totalCost?: number | null; margin?: number | null }
  /** 订单件数(单件口径报价 × 件数换算) */
  quantity?: number | null
  /** 传了就显示「按报价单预填成本」(订单详情编辑用;审批队列只读不传) */
  onPrefillCosts?: (lines: QuoteCostLineUI[], quote: QuoteResultUI) => void
}) {
  const [atts, setAtts] = useState<PoAttachment[]>([])
  const [loading, setLoading] = useState(true)
  const [quotes, setQuotes] = useState<Record<string, QuoteResultUI | 'loading'>>({})

  const load = useCallback(async () => {
    if (!qimoOrderId) { setAtts([]); setLoading(false); return }
    setLoading(true)
    const list = await getOrderAttachments(qimoOrderId)
    setAtts(list)
    const cached: Record<string, QuoteResultUI> = {}
    for (const a of list) {
      const q = (a.extracted_fields as Record<string, unknown> | null)?._quote as QuoteResultUI | undefined
      if (q?.success) cached[a.id] = q
    }
    setQuotes(cached)
    setLoading(false)
  }, [qimoOrderId])
  useEffect(() => { load() }, [load])

  const doExtract = async (att: PoAttachment, force = false) => {
    setQuotes(q => ({ ...q, [att.id]: 'loading' }))
    const res = await extractQuote(att.id, force)
    if (!res.ok || !res.quote) {
      setQuotes(q => { const n = { ...q }; delete n[att.id]; return n })
      toast.error(`识别失败：${res.error || '未知'}`)
      return
    }
    setQuotes(q => ({ ...q, [att.id]: res.quote! }))
  }

  // 报价 → 预算行(单件口径 × 件数;整单口径原样)
  const quoteToBudgetLines = (q: QuoteResultUI): QuoteCostLineUI[] => {
    const qty = q.quantity ?? quantity ?? null
    const src = q.cost_lines || []
    if (!(q as { per_unit?: boolean }).per_unit || !qty) return src
    return src.map(l => ({
      ...l, qty, unit: '件',
      unit_price: l.amount ?? null,
      amount: r2((l.amount || 0) * qty),
    }))
  }

  if (!qimoOrderId) return null

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 py-2 text-sm font-medium border-b flex items-center gap-2">
          <Paperclip className="h-4 w-4" />PO 审批材料
          <span className="text-xs text-muted-foreground font-normal">客户PO单据(人工核价格/总额) + 内部报价单(识别→核预算)</span>
        </div>
        {loading ? (
          <div className="p-5 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
        ) : atts.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">该订单暂无 PO/报价单附件。节拍器推送时带 <code>order_id + doc_hint</code>(契约「四」)即自动出现在这里。</p>
        ) : (
          <div className="p-3 space-y-2">
            {atts.map(a => {
              const q = quotes[a.id]
              const isQuote = a.doc_hint === 'internal_quote'
              const qq = q && q !== 'loading' ? q : null
              // 对照:报价售价总额(单件×件数) vs 预算收入;报价成本 vs 预算成本
              const qty = qq?.quantity ?? quantity ?? null
              const quoteRevenue = qq ? (qq.total_revenue ?? (qq.sell_price != null && qty ? r2(qq.sell_price * qty) : null)) : null
              const quoteCost = qq ? ((qq as { per_unit?: boolean }).per_unit && qty && qq.cost_total != null ? r2(qq.cost_total * qty) : qq.cost_total) : null
              const revDiff = quoteRevenue != null && budget?.revenue != null ? r2((budget.revenue || 0) - quoteRevenue) : null
              const costDiff = quoteCost != null && budget?.totalCost != null ? r2((budget.totalCost || 0) - quoteCost) : null
              return (
                <div key={a.id} className="rounded-lg border">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm truncate">{a.file_name}</span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {a.doc_hint === 'po' ? '客户PO单据' : isQuote ? '内部报价单' : a.doc_hint || '附件'}
                    </Badge>
                    <div className="ml-auto flex gap-1 shrink-0">
                      {a.file_url && <Button size="sm" variant="ghost" className="h-7" onClick={() => openAttachment(a.file_url!)}>查看</Button>}
                      {isQuote && (
                        q === 'loading'
                          ? <Button size="sm" variant="outline" className="h-7" disabled><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />识别中…</Button>
                          : qq ? <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => doExtract(a, true)}>重新识别</Button>
                          : <Button size="sm" variant="outline" className="h-7" onClick={() => doExtract(a)}><Sparkles className="h-3.5 w-3.5 mr-1" />识别报价单</Button>
                      )}
                    </div>
                  </div>
                  {qq && (
                    <div className="border-t px-3 py-2 space-y-2 bg-muted/20">
                      {/* 核对条:报价 vs 预算(PO价格/总额人工看单据;这里核报价与预算一致性+利润) */}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <span>报价售价：<b className="tabular-nums">{qq.currency || 'CNY'} {money(qq.sell_price)}/件{quoteRevenue != null ? ` · 总额 ${money(quoteRevenue)}` : ''}</b></span>
                        <span>报价成本：<b className="tabular-nums">¥{money(quoteCost)}{(qq as { per_unit?: boolean }).per_unit ? `（单件 ${money(qq.cost_total)}）` : ''}</b></span>
                        {budget?.revenue != null && (
                          <span className={revDiff && Math.abs(revDiff) > 0.005 ? 'text-amber-600 font-medium' : 'text-green-700'}>
                            vs 预算收入 {budget.currency || ''} {money(budget.revenue)}{revDiff != null && Math.abs(revDiff) > 0.005 ? `（差 ${revDiff > 0 ? '+' : ''}${money(revDiff)}）` : ' ✓'}
                          </span>
                        )}
                        {budget?.totalCost != null && budget.totalCost > 0 && (
                          <span className={costDiff && Math.abs(costDiff) > 0.005 ? 'text-amber-600 font-medium' : 'text-green-700'}>
                            vs 预算成本 ¥{money(budget.totalCost)}{costDiff != null && Math.abs(costDiff) > 0.005 ? `（差 ${costDiff > 0 ? '+' : ''}${money(costDiff)}）` : ' ✓'}
                          </span>
                        )}
                        {budget?.margin != null && (
                          <span className={Number(budget.margin) < 15 ? 'text-red-600 font-semibold' : 'text-green-700 font-medium'}>
                            预算毛利率 {budget.margin}%{Number(budget.margin) < 15 ? '（低于15%警戒线）' : ''}
                          </span>
                        )}
                      </div>
                      <div className="rounded-md border bg-background overflow-x-auto">
                        <Table>
                          <TableHeader><TableRow>
                            <TableHead className="text-xs">类别</TableHead>
                            <TableHead className="text-xs">明细</TableHead>
                            <TableHead className="text-xs">供应商</TableHead>
                            <TableHead className="text-xs text-right">{(qq as { per_unit?: boolean }).per_unit ? '单件¥' : '金额¥'}</TableHead>
                          </TableRow></TableHeader>
                          <TableBody>
                            {qq.cost_lines.slice(0, 12).map((l, i) => (
                              <TableRow key={i}>
                                <TableCell className="text-xs">{BUCKET_LABELS[l.bucket] || l.bucket}</TableCell>
                                <TableCell className="text-xs">{l.name}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">{l.supplier || '-'}</TableCell>
                                <TableCell className="text-xs text-right tabular-nums font-medium">{money(l.amount)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        {qq.cost_lines.length > 12 && <p className="text-[11px] text-muted-foreground px-2 py-1">共 {qq.cost_lines.length} 行,仅显示前 12。</p>}
                      </div>
                      {onPrefillCosts && (
                        <div className="flex justify-end">
                          <Button size="sm" variant="outline" className="h-7" onClick={() => onPrefillCosts(quoteToBudgetLines(qq), qq)}>
                            <Wand2 className="h-3.5 w-3.5 mr-1" />按报价单预填成本(进编辑器确认)
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
