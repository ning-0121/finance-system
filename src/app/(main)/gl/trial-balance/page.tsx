'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, CheckCircle, AlertTriangle, Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

type GLBalance = {
  account_code: string
  period_code: string
  opening_debit: number
  opening_credit: number
  period_debit: number
  period_credit: number
  closing_debit: number
  closing_credit: number
  accounts: { account_name: string; account_type: string; balance_direction: string } | null
}

const TYPE_LABELS: Record<string, string> = { asset: '资产', liability: '负债', equity: '权益', revenue: '收入', expense: '费用' }

function exportTrialBalanceCSV(period: string, balances: GLBalance[]) {
  const headers = ['科目代码', '科目名称', '类别', '期初借方', '期初贷方', '本期借方', '本期贷方', '期末借方', '期末贷方']
  const rows = balances.map(b => [
    b.account_code,
    b.accounts?.account_name || '',
    TYPE_LABELS[b.accounts?.account_type || ''] || '',
    b.opening_debit, b.opening_credit,
    b.period_debit, b.period_credit,
    b.closing_debit, b.closing_credit,
  ].join(','))

  const totalRow = [
    '合计', '', '',
    balances.reduce((s, b) => s + b.opening_debit, 0),
    balances.reduce((s, b) => s + b.opening_credit, 0),
    balances.reduce((s, b) => s + b.period_debit, 0),
    balances.reduce((s, b) => s + b.period_credit, 0),
    balances.reduce((s, b) => s + b.closing_debit, 0),
    balances.reduce((s, b) => s + b.closing_credit, 0),
  ].join(',')

  const csv = [headers.join(','), ...rows, totalRow].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `试算平衡表_${period}.csv`
  a.click()
  URL.revokeObjectURL(url)
  toast.success('试算平衡表已导出')
}

export default function TrialBalancePage() {
  const [period, setPeriod] = useState('')
  const [periods, setPeriods] = useState<{ period_code: string; status: string }[]>([])
  const [balances, setBalances] = useState<GLBalance[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadPeriods() {
      const supabase = createClient()
      const { data } = await supabase.from('accounting_periods').select('period_code, status').order('period_code', { ascending: false })
      if (data?.length) {
        setPeriods(data as { period_code: string; status: string }[])
        const current = new Date().toISOString().substring(0, 7)
        setPeriod(data.find(p => p.period_code === current)?.period_code || data[0].period_code)
      }
      setLoading(false)
    }
    loadPeriods()
  }, [])

  useEffect(() => {
    if (!period) return
    async function loadBalances() {
      setLoading(true)
      const supabase = createClient()
      const { data } = await supabase
        .from('gl_balances')
        .select('*, accounts(account_name, account_type, balance_direction)')
        .eq('period_code', period)
        .order('account_code')
      setBalances((data as GLBalance[]) || [])
      setLoading(false)
    }
    loadBalances()
  }, [period])

  const totalDebit = balances.reduce((s, b) => s + b.period_debit, 0)
  const totalCredit = balances.reduce((s, b) => s + b.period_credit, 0)
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01

  return (
    <div className="flex flex-col h-full">
      <Header title="试算平衡表" subtitle="总账科目余额汇总 · 借贷平衡验证" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={period} onValueChange={v => setPeriod(v || '')}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="选择期间" /></SelectTrigger>
            <SelectContent>
              {periods.map(p => (
                <SelectItem key={p.period_code} value={p.period_code}>
                  {p.period_code} {p.status === 'closed' ? '(已关闭)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${isBalanced ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
            {isBalanced ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {isBalanced ? '借贷平衡' : '借贷不平衡！'}
          </div>

          {balances.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => exportTrialBalanceCSV(period, balances)}
            >
              <Download className="h-4 w-4 mr-1" />
              导出CSV
            </Button>
          )}
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : balances.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <p>该期间暂无记账数据</p>
                <p className="text-xs mt-1">订单审批通过后会自动生成凭证</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>科目代码</TableHead>
                    <TableHead>科目名称</TableHead>
                    <TableHead>类别</TableHead>
                    <TableHead className="text-right">期初借方</TableHead>
                    <TableHead className="text-right">期初贷方</TableHead>
                    <TableHead className="text-right">本期借方</TableHead>
                    <TableHead className="text-right">本期贷方</TableHead>
                    <TableHead className="text-right">期末借方</TableHead>
                    <TableHead className="text-right">期末贷方</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {balances.map(b => (
                    <TableRow key={b.account_code}>
                      <TableCell className="font-mono text-sm">{b.account_code}</TableCell>
                      <TableCell className="font-medium">{b.accounts?.account_name || '-'}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{TYPE_LABELS[b.accounts?.account_type || ''] || '-'}</Badge></TableCell>
                      <TableCell className="text-right">{b.opening_debit ? `¥${b.opening_debit.toLocaleString()}` : '-'}</TableCell>
                      <TableCell className="text-right">{b.opening_credit ? `¥${b.opening_credit.toLocaleString()}` : '-'}</TableCell>
                      <TableCell className="text-right font-medium">{b.period_debit ? `¥${b.period_debit.toLocaleString()}` : '-'}</TableCell>
                      <TableCell className="text-right font-medium">{b.period_credit ? `¥${b.period_credit.toLocaleString()}` : '-'}</TableCell>
                      <TableCell className="text-right font-semibold">{b.closing_debit ? `¥${b.closing_debit.toLocaleString()}` : '-'}</TableCell>
                      <TableCell className="text-right font-semibold">{b.closing_credit ? `¥${b.closing_credit.toLocaleString()}` : '-'}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-bold bg-muted/30">
                    <TableCell colSpan={3}>合计</TableCell>
                    <TableCell className="text-right">¥{balances.reduce((s, b) => s + b.opening_debit, 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥{balances.reduce((s, b) => s + b.opening_credit, 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥{totalDebit.toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥{totalCredit.toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥{balances.reduce((s, b) => s + b.closing_debit, 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥{balances.reduce((s, b) => s + b.closing_credit, 0).toLocaleString()}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
