'use client'

import { useState, useEffect, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Plus, Pencil, Search, Landmark } from 'lucide-react'
import { toast } from 'sonner'
import { getCustomers, upsertCustomer } from '@/lib/supabase/queries'
import { getSuppliers, upsertSupplier } from '@/lib/supabase/queries-v2'
import { getJournalAccounts, upsertAccount, ACCOUNT_TYPE_LABEL, type JournalAccount } from '@/lib/supabase/bank-journal'
import type { Customer, Supplier } from '@/lib/types'

export default function BankInfoPage() {
  const [tab, setTab] = useState<'customer' | 'supplier' | 'internal'>('customer')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [internals, setInternals] = useState<JournalAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const [custForm, setCustForm] = useState<Partial<Customer> | null>(null)
  const [suppForm, setSuppForm] = useState<Partial<Supplier> | null>(null)
  const [intForm, setIntForm] = useState<Partial<JournalAccount> | null>(null)

  async function reload() {
    setLoading(true)
    const [cs, ss, is] = await Promise.all([getCustomers(), getSuppliers(), getJournalAccounts()])
    setCustomers(cs); setSuppliers(ss); setInternals(is); setLoading(false)
  }
  useEffect(() => { reload() }, [])

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return customers.filter(c => !q || (c.company || '').toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q) || (c.account_no || '').toLowerCase().includes(q))
  }, [customers, search])
  const filteredSuppliers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return suppliers.filter(s => !q || (s.name || '').toLowerCase().includes(q) || (s.account_no || '').toLowerCase().includes(q))
  }, [suppliers, search])
  const filteredInternals = useMemo(() => {
    const q = search.trim().toLowerCase()
    return internals.filter(a => !q || (a.account_name || '').toLowerCase().includes(q) || (a.account_number || '').toLowerCase().includes(q) || (a.bank_name || '').toLowerCase().includes(q))
  }, [internals, search])

  async function saveCustomer() {
    if (!custForm?.company?.trim()) { toast.error('请填写客户公司名'); return }
    setSaving(true)
    const { error } = await upsertCustomer(custForm as Partial<Customer> & { company: string })
    setSaving(false)
    if (error) { toast.error(`保存失败：${error}`); return }
    toast.success('已保存'); setCustForm(null); reload()
  }
  async function saveSupplier() {
    if (!suppForm?.name?.trim()) { toast.error('请填写供应商名称'); return }
    setSaving(true)
    const { error } = await upsertSupplier(suppForm as Partial<Supplier> & { name: string })
    setSaving(false)
    if (error) { toast.error(`保存失败：${error}`); return }
    toast.success('已保存'); setSuppForm(null); reload()
  }
  async function saveInternal() {
    if (!intForm?.account_name?.trim()) { toast.error('请填写账户名称'); return }
    setSaving(true)
    const { error } = await upsertAccount(intForm as Partial<JournalAccount> & { account_name: string })
    setSaving(false)
    if (error) { toast.error(`保存失败：${error}`); return }
    toast.success('已保存'); setIntForm(null); reload()
  }

  const hasBank = (o: { account_no?: string | null; bank_name?: string | null }) => !!(o.account_no || o.bank_name)

  return (
    <div className="flex flex-col h-full">
      <Header title="收款信息维护" subtitle="维护客户 / 供应商的银行收款信息（户名 · 账号 · 开户行）· 录付款/收款时自动带出" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <Tabs value={tab} onValueChange={v => setTab(v as 'customer' | 'supplier' | 'internal')}>
            <TabsList>
              <TabsTrigger value="customer">客户（{customers.length}）</TabsTrigger>
              <TabsTrigger value="supplier">供应商（{suppliers.length}）</TabsTrigger>
              <TabsTrigger value="internal">公司内部账号（{internals.length}）</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <div className="relative max-w-xs"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input placeholder="搜索名称/账号..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} /></div>
            {tab === 'customer'
              ? <Button size="sm" onClick={() => setCustForm({ currency: 'USD' })}><Plus className="h-4 w-4 mr-1" />新建客户</Button>
              : tab === 'supplier'
              ? <Button size="sm" onClick={() => setSuppForm({})}><Plus className="h-4 w-4 mr-1" />新建供应商</Button>
              : <Button size="sm" onClick={() => setIntForm({ currency: 'CNY', account_type: 'bank' })}><Plus className="h-4 w-4 mr-1" />新建内部账号</Button>}
          </div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : tab === 'customer' ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>客户</TableHead>
                    <TableHead>户名</TableHead>
                    <TableHead>账号 / IBAN</TableHead>
                    <TableHead>开户行</TableHead>
                    <TableHead>SWIFT</TableHead>
                    <TableHead>币种</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCustomers.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">无客户</TableCell></TableRow>}
                  {filteredCustomers.map(c => (
                    <TableRow key={c.id} className={hasBank(c) ? '' : 'bg-amber-50/40'}>
                      <TableCell className="font-medium">{c.company || c.name}</TableCell>
                      <TableCell className="text-sm">{c.account_name || '—'}</TableCell>
                      <TableCell className="text-sm font-mono">{c.account_no || '—'}</TableCell>
                      <TableCell className="text-sm">{c.bank_name || '—'}</TableCell>
                      <TableCell className="text-sm font-mono">{c.swift_code || '—'}</TableCell>
                      <TableCell className="text-sm">{c.currency}</TableCell>
                      <TableCell className="text-center"><Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setCustForm({ ...c })}><Pencil className="h-3.5 w-3.5 mr-1" />编辑</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : tab === 'supplier' ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>供应商</TableHead>
                    <TableHead>户名</TableHead>
                    <TableHead>账号</TableHead>
                    <TableHead>开户行</TableHead>
                    <TableHead>联系</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSuppliers.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">无供应商</TableCell></TableRow>}
                  {filteredSuppliers.map(s => (
                    <TableRow key={s.id} className={hasBank(s) ? '' : 'bg-amber-50/40'}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-sm">{s.account_name || '—'}</TableCell>
                      <TableCell className="text-sm font-mono">{s.account_no || '—'}</TableCell>
                      <TableCell className="text-sm">{s.bank_name || '—'}</TableCell>
                      <TableCell className="text-sm">{s.contact || s.phone || '—'}</TableCell>
                      <TableCell className="text-center"><Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setSuppForm({ ...s })}><Pencil className="h-3.5 w-3.5 mr-1" />编辑</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>账户名称</TableHead>
                    <TableHead>账号</TableHead>
                    <TableHead>币种</TableHead>
                    <TableHead>开户行</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInternals.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-16 text-muted-foreground">无内部账号</TableCell></TableRow>}
                  {filteredInternals.map(a => (
                    <TableRow key={a.id} className={a.is_active ? '' : 'opacity-50'}>
                      <TableCell className="font-medium">{a.account_name}{a.account_type ? <span className="ml-1.5 text-xs text-muted-foreground">{ACCOUNT_TYPE_LABEL[a.account_type] || ''}</span> : null}{a.is_active ? '' : <span className="ml-1.5 text-xs text-muted-foreground">（已停用）</span>}</TableCell>
                      <TableCell className="text-sm font-mono">{a.account_number || '—'}</TableCell>
                      <TableCell className="text-sm">{a.currency}</TableCell>
                      <TableCell className="text-sm">{a.bank_name || '—'}</TableCell>
                      <TableCell className="text-center"><Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setIntForm({ ...a })}><Pencil className="h-3.5 w-3.5 mr-1" />编辑</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground flex items-center gap-1"><Landmark className="h-3.5 w-3.5" />标黄行=尚未填写银行信息。供应商信息在“付款审批”录入时自动带出收款人；客户信息可用于开票/电汇资料。</p>
      </div>

      {/* 客户编辑 */}
      <Dialog open={!!custForm} onOpenChange={o => { if (!o) setCustForm(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{custForm?.id ? '编辑客户收款信息' : '新建客户'}</DialogTitle></DialogHeader>
          {custForm && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label>客户公司名 *</Label><Input value={custForm.company || ''} onChange={e => setCustForm({ ...custForm, company: e.target.value })} /></div>
                <div className="space-y-1"><Label>简称/联系人</Label><Input value={custForm.contact || ''} onChange={e => setCustForm({ ...custForm, contact: e.target.value })} /></div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1"><Label>国家</Label><Input value={custForm.country || ''} onChange={e => setCustForm({ ...custForm, country: e.target.value })} /></div>
                <div className="space-y-1"><Label>币种</Label><Input value={custForm.currency || ''} onChange={e => setCustForm({ ...custForm, currency: e.target.value })} placeholder="USD" /></div>
                <div className="space-y-1"><Label>电话</Label><Input value={custForm.phone || ''} onChange={e => setCustForm({ ...custForm, phone: e.target.value })} /></div>
              </div>
              <div className="border-t pt-3 space-y-3">
                <p className="text-sm font-medium">银行 / 收款信息</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label>户名</Label><Input value={custForm.account_name || ''} onChange={e => setCustForm({ ...custForm, account_name: e.target.value })} /></div>
                  <div className="space-y-1"><Label>账号 / IBAN</Label><Input value={custForm.account_no || ''} onChange={e => setCustForm({ ...custForm, account_no: e.target.value })} /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label>开户行</Label><Input value={custForm.bank_name || ''} onChange={e => setCustForm({ ...custForm, bank_name: e.target.value })} /></div>
                  <div className="space-y-1"><Label>SWIFT / BIC</Label><Input value={custForm.swift_code || ''} onChange={e => setCustForm({ ...custForm, swift_code: e.target.value })} /></div>
                </div>
                <div className="space-y-1"><Label>银行地址（电汇用，可选）</Label><Input value={custForm.bank_address || ''} onChange={e => setCustForm({ ...custForm, bank_address: e.target.value })} /></div>
              </div>
              <div className="space-y-1"><Label>备注</Label><Input value={custForm.notes || ''} onChange={e => setCustForm({ ...custForm, notes: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustForm(null)}>取消</Button>
            <Button onClick={saveCustomer} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 供应商编辑 */}
      <Dialog open={!!suppForm} onOpenChange={o => { if (!o) setSuppForm(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{suppForm?.id ? '编辑供应商收款信息' : '新建供应商'}</DialogTitle></DialogHeader>
          {suppForm && (
            <div className="space-y-3 py-2">
              <div className="space-y-1"><Label>供应商名称 *</Label><Input value={suppForm.name || ''} onChange={e => setSuppForm({ ...suppForm, name: e.target.value })} /></div>
              <div className="border-t pt-3 space-y-3">
                <p className="text-sm font-medium">银行 / 收款信息</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label>户名</Label><Input value={suppForm.account_name || ''} onChange={e => setSuppForm({ ...suppForm, account_name: e.target.value })} /></div>
                  <div className="space-y-1"><Label>银行账号</Label><Input value={suppForm.account_no || ''} onChange={e => setSuppForm({ ...suppForm, account_no: e.target.value })} /></div>
                </div>
                <div className="space-y-1"><Label>开户行</Label><Input value={suppForm.bank_name || ''} onChange={e => setSuppForm({ ...suppForm, bank_name: e.target.value })} placeholder="如：中国银行义乌分行" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label>联系人</Label><Input value={suppForm.contact || ''} onChange={e => setSuppForm({ ...suppForm, contact: e.target.value })} /></div>
                <div className="space-y-1"><Label>电话</Label><Input value={suppForm.phone || ''} onChange={e => setSuppForm({ ...suppForm, phone: e.target.value })} /></div>
              </div>
              <div className="space-y-1"><Label>备注</Label><Input value={suppForm.notes || ''} onChange={e => setSuppForm({ ...suppForm, notes: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuppForm(null)}>取消</Button>
            <Button onClick={saveSupplier} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 公司内部账号编辑 */}
      <Dialog open={!!intForm} onOpenChange={o => { if (!o) setIntForm(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{intForm?.id ? '编辑公司内部账号' : '新建公司内部账号'}</DialogTitle></DialogHeader>
          {intForm && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label>账户名称 *</Label><Input value={intForm.account_name || ''} onChange={e => setIntForm({ ...intForm, account_name: e.target.value })} placeholder="如：招商银行-基本户" /></div>
                <div className="space-y-1"><Label>类型</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" value={intForm.account_type || 'bank'} onChange={e => setIntForm({ ...intForm, account_type: e.target.value as JournalAccount['account_type'] })}>
                    {Object.entries(ACCOUNT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label>账号</Label><Input value={intForm.account_number || ''} onChange={e => setIntForm({ ...intForm, account_number: e.target.value })} /></div>
                <div className="space-y-1"><Label>币种</Label><Input value={intForm.currency || ''} onChange={e => setIntForm({ ...intForm, currency: e.target.value })} placeholder="CNY" /></div>
              </div>
              <div className="space-y-1"><Label>开户行</Label><Input value={intForm.bank_name || ''} onChange={e => setIntForm({ ...intForm, bank_name: e.target.value })} placeholder="如：招商银行义乌分行" /></div>
              {intForm.id && (
                <label className="flex items-center gap-2 text-sm pt-1"><input type="checkbox" checked={intForm.is_active ?? true} onChange={e => setIntForm({ ...intForm, is_active: e.target.checked })} />启用（取消勾选=停用，不再出现在选择列表）</label>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIntForm(null)}>取消</Button>
            <Button onClick={saveInternal} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
