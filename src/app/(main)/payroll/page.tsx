'use client'

// ============================================================
// 工资条发放 — 导入算好的工资表 → 生成工资条 → 企业微信私发
// 不做工资计算。薪资敏感：仅财务经理/管理员可见可操作。
// ============================================================
import { useState, useEffect, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Upload, Users, Send, RefreshCw, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import {
  getEmployees, getBatches, getSlips, importPayrollBatch, signedAmount,
  type Employee, type PayrollBatch, type PayrollSlip,
} from '@/lib/supabase/payroll'

const parseNum = (v: unknown) => { const n = Number(String(v ?? '').replace(/[,¥$\s]/g, '')); return isNaN(n) ? 0 : n }
const SEND_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: '待发', cls: 'bg-blue-100 text-blue-700' },
  sent: { label: '已发', cls: 'bg-green-100 text-green-700' },
  failed: { label: '失败', cls: 'bg-red-100 text-red-700' },
  skipped: { label: '跳过', cls: 'bg-amber-100 text-amber-700' },
}

export default function PayrollPage() {
  const { user, loading: userLoading } = useCurrentUser()
  const role = user?.role || ''
  const allowed = ['finance_manager', 'admin'].includes(role)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [batches, setBatches] = useState<PayrollBatch[]>([])
  const [activeBatch, setActiveBatch] = useState<string>('')
  const [slips, setSlips] = useState<PayrollSlip[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 导入
  const [importOpen, setImportOpen] = useState(false)
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [nameCol, setNameCol] = useState('')
  const [netCol, setNetCol] = useState('')
  const [period, setPeriod] = useState('')
  const [importing, setImporting] = useState(false)

  const loadBatch = useCallback(async (id: string) => { setSlips(await getSlips(id)) }, [])
  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [emps, bs] = await Promise.all([getEmployees(), getBatches()])
      setEmployees(emps); setBatches(bs)
      if (bs.length > 0) { setActiveBatch(bs[0].id); await loadBatch(bs[0].id) }
    } catch (e) { toast.error(`加载失败：${e instanceof Error ? e.message : '未知'}（若提示表不存在，请先执行迁移 20260613_payroll.sql）`) }
    finally { setLoading(false) }
  }, [loadBatch])
  useEffect(() => { if (allowed) loadAll(); else setLoading(false) }, [allowed, loadAll])

  const syncEmployees = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/payroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync_employees' }) })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error)
      toast.success(`通讯录同步完成：${j.synced} 人`)
      setEmployees(await getEmployees())
    } catch (e) { toast.error(`同步失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setSyncing(false) }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', blankrows: false, raw: false }) as Record<string, unknown>[]
      if (rows.length === 0) { toast.error('未解析到数据行'); return }
      setRawRows(rows)
      const hs = Object.keys(rows[0]); setHeaders(hs)
      setNameCol(hs.find(h => h.includes('姓名') || h.includes('员工') || h.includes('名字')) || '')
      setNetCol(hs.find(h => h.includes('实发') || h.includes('实得') || h.includes('应发合计') || h.toLowerCase().includes('net')) || '')
      setImportOpen(true)
    } catch (e) { toast.error(`解析失败：${e instanceof Error ? e.message : '未知'}`) }
  }

  const doImport = async () => {
    if (!period.trim()) { toast.error('请填写发薪期间（如 2026-06）'); return }
    if (!nameCol || !netCol) { toast.error('请选择「姓名列」和「实发列」'); return }
    setImporting(true)
    try {
      const itemCols = headers.filter(h => h !== nameCol)  // 实发列也展示为明细项
      const rows = rawRows.map(r => {
        const name = String(r[nameCol] || '').trim()
        const items = itemCols
          .map(h => ({ label: h, raw: parseNum(r[h]) }))
          .filter(x => x.raw !== 0)
          .map(x => ({ label: x.label, amount: x.label === netCol ? parseNum(r[netCol]) : signedAmount(x.label, x.raw) }))
        return { name, netPay: parseNum(r[netCol]), items }
      }).filter(r => r.name)
      if (rows.length === 0) { toast.error('没有有效工资行'); setImporting(false); return }
      const { batchId, matched, unmatched, error } = await importPayrollBatch(period.trim(), `${period.trim()} 工资条`, rows)
      if (error) throw new Error(error)
      toast.success(`已生成 ${rows.length} 张工资条（匹配 ${matched} 人${unmatched > 0 ? `，${unmatched} 人未匹配花名册` : ''}）`)
      setImportOpen(false); setRawRows([])
      await loadAll()
      if (batchId) { setActiveBatch(batchId); await loadBatch(batchId) }
    } catch (e) { toast.error(`导入失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setImporting(false) }
  }

  const sendBatch = async () => {
    if (!activeBatch) return
    const pending = slips.filter(s => s.send_status === 'pending').length
    if (pending === 0) { toast.error('没有待发工资条（未匹配花名册的需先补员工或同步通讯录）'); return }
    if (!confirm(`确认通过企业微信向 ${pending} 人发送工资条？发送后员工立即收到。`)) return
    setSending(true)
    try {
      const res = await fetch('/api/payroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send_batch', batchId: activeBatch }) })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error)
      toast.success(`发送完成：成功 ${j.sent}${j.failed ? `，失败 ${j.failed}` : ''}${j.skipped ? `，跳过 ${j.skipped}` : ''}`)
      await loadBatch(activeBatch); await loadAll()
    } catch (e) { toast.error(`发送失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setSending(false) }
  }

  if (userLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  if (!allowed) return (
    <div className="flex flex-col h-full">
      <Header title="工资条发放" subtitle="薪资保密" />
      <div className="flex-1 flex items-center justify-center"><Card className="max-w-sm"><CardContent className="py-12 text-center text-muted-foreground"><Lock className="h-10 w-10 mx-auto mb-3 opacity-40" /><p>工资条涉及薪资保密，仅财务经理 / 管理员可访问</p></CardContent></Card></div>
    </div>
  )

  const matchedCount = employees.filter(e => e.wecom_userid).length

  return (
    <div className="flex flex-col h-full">
      <Header title="工资条发放" subtitle="导入工资表 · 一键生成工资条 · 企业微信私发" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant="outline" className="text-sm"><Users className="h-3 w-3 mr-1" />花名册 {employees.length} 人（{matchedCount} 人有企微）</Badge>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={syncEmployees} disabled={syncing}>{syncing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}同步通讯录</Button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { onFile(e.target.files?.[0]); if (fileRef.current) fileRef.current.value = '' }} />
            <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4 mr-1" />导入工资表</Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : batches.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>还没有工资批次</p>
            <p className="text-xs mt-1">先「同步通讯录」拉花名册，再「导入工资表」（算好的 Excel）生成工资条</p>
          </CardContent></Card>
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <Select value={activeBatch} onValueChange={v => { if (v) { setActiveBatch(v); loadBatch(v) } }}>
                <SelectTrigger className="w-[280px]"><SelectValue placeholder="选择批次" /></SelectTrigger>
                <SelectContent>{batches.map(b => <SelectItem key={b.id} value={b.id}>{b.title}（{b.slip_count}人 · 已发{b.sent_count}）</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" onClick={sendBatch} disabled={sending}>{sending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}一键发放（企业微信）</Button>
            </div>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">工资条明细（实发合计 ¥{slips.reduce((s, x) => s + Number(x.net_pay), 0).toLocaleString()}）</CardTitle></CardHeader>
              <Table>
                <TableHeader><TableRow>
                  <TableHead>姓名</TableHead><TableHead>明细</TableHead><TableHead className="text-right">实发</TableHead>
                  <TableHead>企微</TableHead><TableHead>发送</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {slips.map(s => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.employee_name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[360px]">
                        {(s.items || []).map(it => `${it.label} ${it.amount < 0 ? '-' : ''}¥${Math.abs(it.amount).toLocaleString()}`).join(' · ')}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">¥{Number(s.net_pay).toLocaleString()}</TableCell>
                      <TableCell>{s.wecom_userid ? <span className="text-xs text-green-600">✓</span> : <span className="text-xs text-amber-600" title={s.send_error || ''}>未匹配</span>}</TableCell>
                      <TableCell><Badge className={SEND_BADGE[s.send_status].cls}>{SEND_BADGE[s.send_status].label}</Badge>{s.send_status === 'failed' && s.send_error && <span className="block text-[10px] text-red-500">{s.send_error}</span>}</TableCell>
                    </TableRow>
                  ))}
                  {slips.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">该批次无工资条</TableCell></TableRow>}
                </TableBody>
              </Table>
            </Card>
          </>
        )}
      </div>

      {/* 导入列映射 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>导入工资表（已解析 {rawRows.length} 行）</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1"><Label className="text-xs">发薪期间 *</Label><Input placeholder="2026-06" value={period} onChange={e => setPeriod(e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">姓名列 *</Label>
              <Select value={nameCol || '__none__'} onValueChange={v => setNameCol(v && v !== '__none__' ? v : '')}>
                <SelectTrigger className="h-8"><SelectValue placeholder="选择" /></SelectTrigger>
                <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label className="text-xs">实发列 *</Label>
              <Select value={netCol || '__none__'} onValueChange={v => setNetCol(v && v !== '__none__' ? v : '')}>
                <SelectTrigger className="h-8"><SelectValue placeholder="选择" /></SelectTrigger>
                <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground">其余数值列将自动作为工资条明细项（含「扣」「社保」「个税」「公积金」字样的列按扣减项显示）。姓名按花名册唯一匹配企微账号，重名/未建档的会标「未匹配」、发放时跳过。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button>
            <Button onClick={doImport} disabled={importing}>{importing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}生成工资条</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
