'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Loader2, FileText, Eye, Download } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

type JournalEntry = {
  id: string
  voucher_no: string
  period_code: string
  voucher_date: string
  voucher_type: string
  description: string
  source_type: string | null
  total_debit: number
  total_credit: number
  status: string
  created_at: string
}

type JournalLine = {
  id: string
  line_no: number
  account_code: string
  description: string | null
  debit: number
  credit: number
  accounts: { account_name: string } | null
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'bg-gray-100 text-gray-700' },
  posted: { label: '已过账', color: 'bg-green-100 text-green-700' },
  voided: { label: '已作废', color: 'bg-red-100 text-red-700' },
}

const TYPE_MAP: Record<string, string> = { auto: '自动', manual: '手工', closing: '结转' }
const SOURCE_MAP: Record<string, string> = { budget_order: '订单审批', settlement: '订单决算', receipt: '收款', payment: '付款' }

function exportJournalCSV(period: string, entries: JournalEntry[]) {
  const headers = ['凭证号', '日期', '类型', '摘要', '来源', '借方合计', '贷方合计', '状态']
  const rows = entries.map(e => [
    e.voucher_no, e.voucher_date,
    TYPE_MAP[e.voucher_type] || e.voucher_type,
    `"${e.description.replace(/"/g, '""')}"`,
    SOURCE_MAP[e.source_type || ''] || e.source_type || '',
    e.total_debit, e.total_credit,
    STATUS_MAP[e.status]?.label || e.status,
  ].join(','))
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `记账凭证_${period}.csv`
  a.click()
  URL.revokeObjectURL(url)
  toast.success('凭证列表已导出')
}

export default function JournalPage() {
  const [period, setPeriod] = useState('')
  const [periods, setPeriods] = useState<string[]>([])
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<{ entry: JournalEntry; lines: JournalLine[] } | null>(null)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data } = await supabase.from('accounting_periods').select('period_code').order('period_code', { ascending: false })
      if (data?.length) {
        const codes = data.map(x => x.period_code as string)
        setPeriods(codes)
        const current = new Date().toISOString().substring(0, 7)
        setPeriod(codes.find(c => c === current) || codes[0])
      }
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (!period) return
    async function loadEntries() {
      setLoading(true)
      const supabase = createClient()
      const { data } = await supabase
        .from('journal_entries')
        .select('*')
        .eq('period_code', period)
        .order('voucher_no')
      setEntries((data as JournalEntry[]) || [])
      setLoading(false)
    }
    loadEntries()
  }, [period])

  const handleViewDetail = async (entry: JournalEntry) => {
    const supabase = createClient()
    const { data } = await supabase
      .from('journal_lines')
      .select('*, accounts(account_name)')
      .eq('journal_id', entry.id)
      .order('line_no')
    setDetail({ entry, lines: (data as JournalLine[]) || [] })
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="记账凭证" subtitle="查看系统自动生成和手工录入的会计凭证" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <Select value={period} onValueChange={v => setPeriod(v || '')}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="选择期间" /></SelectTrigger>
            <SelectContent>
              {periods.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">共 {entries.length} 张凭证</p>
            {entries.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => exportJournalCSV(period, entries)}>
                <Download className="h-4 w-4 mr-1" />导出CSV
              </Button>
            )}
          </div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : entries.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>该期间暂无凭证</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>凭证号</TableHead>
                    <TableHead>日期</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>摘要</TableHead>
                    <TableHead>来源</TableHead>
                    <TableHead className="text-right">借方</TableHead>
                    <TableHead className="text-right">贷方</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map(e => {
                    const sc = STATUS_MAP[e.status] || STATUS_MAP.draft
                    return (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-sm font-medium">{e.voucher_no}</TableCell>
                        <TableCell className="text-sm">{e.voucher_date}</TableCell>
                        <TableCell><Badge variant="outline" className="text-[10px]">{TYPE_MAP[e.voucher_type] || e.voucher_type}</Badge></TableCell>
                        <TableCell className="max-w-[200px] truncate">{e.description}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{SOURCE_MAP[e.source_type || ''] || e.source_type || '-'}</TableCell>
                        <TableCell className="text-right font-medium">¥{e.total_debit.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-medium">¥{e.total_credit.toLocaleString()}</TableCell>
                        <TableCell><Badge className={`${sc.color} border-0 text-[10px]`}>{sc.label}</Badge></TableCell>
                        <TableCell className="text-center">
                          <Button size="sm" variant="ghost" onClick={() => handleViewDetail(e)}><Eye className="h-3.5 w-3.5" /></Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 凭证明细弹窗 */}
      {detail && (
        <Dialog open onOpenChange={() => setDetail(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>凭证 {detail.entry.voucher_no}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex gap-4 text-muted-foreground">
                <span>日期: {detail.entry.voucher_date}</span>
                <span>类型: {TYPE_MAP[detail.entry.voucher_type]}</span>
                <span>来源: {SOURCE_MAP[detail.entry.source_type || ''] || '-'}</span>
              </div>
              <p className="font-medium">{detail.entry.description}</p>
              <Separator />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>序号</TableHead>
                    <TableHead>科目</TableHead>
                    <TableHead>摘要</TableHead>
                    <TableHead className="text-right">借方</TableHead>
                    <TableHead className="text-right">贷方</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.lines.map(l => (
                    <TableRow key={l.id}>
                      <TableCell>{l.line_no}</TableCell>
                      <TableCell className="font-mono">{l.account_code} {(l.accounts as unknown as Record<string, string>)?.account_name || ''}</TableCell>
                      <TableCell className="text-muted-foreground">{l.description || '-'}</TableCell>
                      <TableCell className="text-right font-medium">{l.debit > 0 ? `¥${l.debit.toLocaleString()}` : ''}</TableCell>
                      <TableCell className="text-right font-medium">{l.credit > 0 ? `¥${l.credit.toLocaleString()}` : ''}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-bold bg-muted/30">
                    <TableCell colSpan={3} className="text-right">合计</TableCell>
                    <TableCell className="text-right">¥{detail.entry.total_debit.toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥{detail.entry.total_credit.toLocaleString()}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
