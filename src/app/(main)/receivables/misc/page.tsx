'use client'

// 杂项/独立应收(misc_receivables):节拍器 receivable.created 推来的打样费等【不挂订单总收入】的应收。
// 财务在此看 open 应收、确认收款(置 received + 回传节拍器 collection.received 闭环)。

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, Inbox, CheckCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useCurrentUser } from '@/lib/hooks/use-current-user'

interface MiscReceivable {
  id: string
  kind: string
  customer_name: string
  amount: number
  currency: string
  order_no: string | null
  internal_order_no: string | null
  status: 'open' | 'received' | 'cancelled'
  received_amount: number | null
  received_at: string | null
  created_at: string
}

const KIND_LABEL: Record<string, string> = { sample_fee: '打样费' }
const fmtDate = (v: string | null) => { if (!v) return '—'; try { return new Date(v).toLocaleDateString('zh-CN') } catch { return String(v) } }
const money = (n: number, c: string) => `${c === 'CNY' ? '¥' : c + ' '}${(Number(n) || 0).toLocaleString()}`

export default function MiscReceivablesPage() {
  const { user } = useCurrentUser()
  const [rows, setRows] = useState<MiscReceivable[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await createClient()
      .from('misc_receivables')
      .select('id, kind, customer_name, amount, currency, order_no, internal_order_no, status, received_amount, received_at, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(300)
    setRows((data as MiscReceivable[]) || [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const canReceive = !!user && ['admin', 'finance_manager', 'finance_staff'].includes(user.role || '')

  const receive = async (r: MiscReceivable) => {
    if (!confirm(`确认收到「${r.customer_name} · ${KIND_LABEL[r.kind] || r.kind} · ${money(r.amount, r.currency)}」的款？\n\n收款后会回传节拍器(collection.received)。`)) return
    setBusy(r.id)
    try {
      const res = await fetch('/api/integration/receivable-receipt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || `HTTP ${res.status}`); return }
      toast[json.callback_sent ? 'success' : 'warning'](
        '已确认收款' + (json.callback_sent ? '，已回传节拍器' : '，但回传节拍器失败(已入 outbox 重试)')
      )
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '收款失败')
    } finally { setBusy(null) }
  }

  const openRows = rows.filter(r => r.status === 'open')
  const doneRows = rows.filter(r => r.status !== 'open')

  return (
    <div className="flex flex-col h-full">
      <Header title="杂项应收" subtitle="打样费等独立应收(节拍器推送)· 收款后回传闭环" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              待收款
              {openRows.length > 0 && <Badge className="bg-amber-100 text-amber-700">{openRows.length}</Badge>}
            </CardTitle>
            <p className="text-xs text-muted-foreground">节拍器 receivable.created 推来的打样费等应收。确认收款后置「已收」并回传节拍器记入该订单财务时间线。</p>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : openRows.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground"><Inbox className="h-10 w-10 mx-auto mb-2 opacity-30" /><p className="text-sm">暂无待收款的杂项应收</p></div>
            ) : (
              <Table>
                <TableHeader><TableRow>
                  <TableHead>类型</TableHead><TableHead>客户</TableHead><TableHead>关联单号</TableHead>
                  <TableHead className="text-right">金额</TableHead><TableHead>创建</TableHead><TableHead className="text-center">操作</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {openRows.map(r => (
                    <TableRow key={r.id}>
                      <TableCell><Badge variant="secondary" className="bg-blue-100 text-blue-700">{KIND_LABEL[r.kind] || r.kind}</Badge></TableCell>
                      <TableCell className="font-medium">{r.customer_name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.order_no || r.internal_order_no || '—'}</TableCell>
                      <TableCell className="text-right font-semibold whitespace-nowrap">{money(r.amount, r.currency)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(r.created_at)}</TableCell>
                      <TableCell className="text-center">
                        {canReceive ? (
                          <Button size="sm" disabled={busy === r.id} onClick={() => receive(r)}>
                            {busy === r.id ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}确认收款
                          </Button>
                        ) : <span className="text-xs text-muted-foreground">仅财务可收款</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {doneRows.length > 0 && (
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">已处理(近 300 条内)</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>类型</TableHead><TableHead>客户</TableHead><TableHead className="text-right">金额</TableHead>
                  <TableHead>状态</TableHead><TableHead>收款时间</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {doneRows.map(r => (
                    <TableRow key={r.id}>
                      <TableCell><Badge variant="secondary" className="bg-blue-50 text-blue-600">{KIND_LABEL[r.kind] || r.kind}</Badge></TableCell>
                      <TableCell>{r.customer_name}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{money(r.received_amount ?? r.amount, r.currency)}</TableCell>
                      <TableCell>{r.status === 'received' ? <Badge className="bg-green-100 text-green-700">已收</Badge> : <Badge variant="secondary">已取消</Badge>}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(r.received_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
