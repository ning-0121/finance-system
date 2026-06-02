'use client'

// ============================================================
// GL 受控灰度 · 复核中心
//   - 待复核草稿凭证：财务经理点「过账」→ /api/gl/journal/[id]/post
//   - 过账失败队列：查看原因 + 「重试」→ /api/gl/queue/[id]/retry
// 试运行边界：默认只生成 draft，必须人工 review 后才 posted。
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { createClient } from '@/lib/supabase/client'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import { toast } from 'sonner'
import { Loader2, CheckCircle2, RefreshCw, AlertTriangle, FileText } from 'lucide-react'

interface DraftRow {
  id: string; voucher_no: string; voucher_date: string; description: string
  total_debit: number; business_event: string; explanation: string | null
  exchange_rate_source: string | null; related_order_id: string | null; created_at: string
}
interface FailRow {
  id: string; business_event: string; source_type: string; source_id: string
  last_error_code: string | null; last_error: string | null; attempts: number
  journal_id: string | null; updated_at: string
}

const EVENT_LABEL: Record<string, string> = {
  order_approved: '审批·确认收入', settlement_confirmed: '决算·结转成本',
  receipt_saved: '回款·银行/应收', payment_registered: '付款·应付/银行',
}
const CODE_LABEL: Record<string, string> = {
  MISSING_RATE: '缺汇率', PERIOD_CLOSED: '会计期间已关闭', ACCOUNT_MISSING: '科目缺失',
  UNBALANCED: '借贷不平', RPC_FAILED: 'RPC失败', RLS_FAILED: 'RLS失败',
  FREEZE_BLOCKED: '冻结拦截', DUPLICATE_SOURCE: '重复来源', MISSING_SOURCE_DOC: '源单据缺失',
  MISSING_PROVENANCE: '溯源不完整',
}

export default function GlReviewPage() {
  const { user } = useCurrentUser()
  const canPost = !!user && (user.role === 'admin' || user.role === 'finance_manager')
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [fails, setFails] = useState<FailRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [d, f] = await Promise.all([
        supabase.from('journal_entries')
          .select('id, voucher_no, voucher_date, description, total_debit, business_event, explanation, exchange_rate_source, related_order_id, created_at')
          .eq('status', 'draft').order('created_at', { ascending: false }).limit(200),
        supabase.from('gl_posting_queue')
          .select('id, business_event, source_type, source_id, last_error_code, last_error, attempts, journal_id, updated_at')
          .eq('status', 'failed').order('updated_at', { ascending: false }).limit(200),
      ])
      setDrafts((d.data as DraftRow[]) || [])
      setFails((f.data as FailRow[]) || [])
    } catch (e) {
      console.error(e); toast.error('加载失败')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const postDraft = async (id: string) => {
    setBusy(id)
    try {
      const res = await fetch(`/api/gl/journal/${id}/post`, { method: 'POST' })
      const j = await res.json()
      if (!res.ok) { toast.error(j.error || '过账失败'); return }
      toast.success('已过账')
      await load()
    } catch { toast.error('过账失败') } finally { setBusy(null) }
  }

  const retryFail = async (id: string) => {
    setBusy(id)
    try {
      const res = await fetch(`/api/gl/queue/${id}/retry`, { method: 'POST' })
      const j = await res.json()
      if (j?.result?.status === 'failed') toast.warning(`仍失败：${CODE_LABEL[j.result.code] || j.result.code || ''}`)
      else toast.success(`重试结果：${j?.result?.status || '完成'}`)
      await load()
    } catch { toast.error('重试失败') } finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="GL 复核中心" subtitle="受控灰度 · 草稿凭证需人工复核后过账" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-2 gap-4">
          <Card><CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-amber-600">{drafts.length}</p>
            <p className="text-xs text-muted-foreground mt-1">待复核草稿凭证</p>
          </CardContent></Card>
          <Card><CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-red-600">{fails.length}</p>
            <p className="text-xs text-muted-foreground mt-1">过账失败（待处理）</p>
          </CardContent></Card>
        </div>

        {!canPost && (
          <p className="text-sm text-amber-600">当前角色仅可查看；「过账」需财务经理/管理员权限。</p>
        )}

        {/* 待复核草稿 */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><FileText className="h-4 w-4" />待复核草稿凭证</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin inline" /></div> : (
              <Table>
                <TableHeader><TableRow>
                  <TableHead>凭证号</TableHead><TableHead>日期</TableHead><TableHead>业务</TableHead>
                  <TableHead>摘要</TableHead><TableHead className="text-right">金额(借)</TableHead>
                  <TableHead>汇率来源</TableHead><TableHead></TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {drafts.length === 0 ? <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">无待复核草稿</TableCell></TableRow> :
                  drafts.map(d => (
                    <TableRow key={d.id}>
                      <TableCell className="font-mono text-xs">{d.voucher_no}</TableCell>
                      <TableCell className="text-xs">{d.voucher_date}</TableCell>
                      <TableCell><Badge variant="secondary" className="text-[10px]">{EVENT_LABEL[d.business_event] || d.business_event}</Badge></TableCell>
                      <TableCell className="text-xs max-w-[260px]"><div className="truncate" title={d.explanation || d.description}>{d.description}</div></TableCell>
                      <TableCell className="text-right tabular-nums">¥{Number(d.total_debit).toLocaleString()}</TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{d.exchange_rate_source || '—'}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="default" disabled={!canPost || busy === d.id} onClick={() => postDraft(d.id)}>
                          {busy === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><CheckCircle2 className="h-3.5 w-3.5 mr-1" />过账</>}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* 过账失败 */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-red-500" />过账失败队列</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>业务</TableHead><TableHead>失败类型</TableHead><TableHead>原因</TableHead>
                <TableHead className="text-center">尝试</TableHead><TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {fails.length === 0 ? <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">无失败项</TableCell></TableRow> :
                fails.map(f => (
                  <TableRow key={f.id}>
                    <TableCell><Badge variant="secondary" className="text-[10px]">{EVENT_LABEL[f.business_event] || f.business_event}</Badge></TableCell>
                    <TableCell><Badge variant="destructive" className="text-[10px]">{CODE_LABEL[f.last_error_code || ''] || f.last_error_code || '未知'}</Badge></TableCell>
                    <TableCell className="text-xs max-w-[320px]"><div className="truncate" title={f.last_error || ''}>{f.last_error}</div></TableCell>
                    <TableCell className="text-center text-xs">{f.attempts}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" disabled={busy === f.id} onClick={() => retryFail(f.id)}>
                        {busy === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><RefreshCw className="h-3.5 w-3.5 mr-1" />重试</>}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
