'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Search, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type Account = {
  id: string
  account_code: string
  account_name: string
  account_type: string
  level: number
  balance_direction: string
  is_detail: boolean
  is_active: boolean
  description: string | null
}

const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  asset: { label: '资产', color: 'bg-blue-100 text-blue-700' },
  liability: { label: '负债', color: 'bg-red-100 text-red-700' },
  equity: { label: '权益', color: 'bg-purple-100 text-purple-700' },
  revenue: { label: '收入', color: 'bg-green-100 text-green-700' },
  expense: { label: '费用', color: 'bg-amber-100 text-amber-700' },
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data } = await supabase.from('accounts').select('*').order('account_code')
      setAccounts((data as Account[]) || [])
      setLoading(false)
    }
    load()
  }, [])

  const filtered = accounts.filter(a =>
    !search || a.account_code.includes(search) || a.account_name.includes(search)
  )

  const byType = Object.entries(TYPE_CONFIG).map(([type, cfg]) => ({
    ...cfg, type, count: accounts.filter(a => a.account_type === type).length,
  }))

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="科目表" subtitle="会计科目设置 · 外贸服装行业标准科目" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex gap-2 flex-wrap">
          {byType.map(t => (
            <Card key={t.type} className="flex-1 min-w-[100px]">
              <CardContent className="p-3 text-center">
                <Badge className={`${t.color} border-0 mb-1`}>{t.label}</Badge>
                <p className="text-lg font-bold">{t.count}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索科目代码或名称..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>科目代码</TableHead>
                  <TableHead>科目名称</TableHead>
                  <TableHead>类别</TableHead>
                  <TableHead>层级</TableHead>
                  <TableHead>余额方向</TableHead>
                  <TableHead>可记账</TableHead>
                  <TableHead>说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(a => {
                  const tc = TYPE_CONFIG[a.account_type] || TYPE_CONFIG.asset
                  return (
                    <TableRow key={a.id} className={a.level === 1 ? 'font-medium' : ''}>
                      <TableCell className="font-mono">{a.level > 1 ? `  ${a.account_code}` : a.account_code}</TableCell>
                      <TableCell className={a.level > 1 ? 'pl-8' : ''}>{a.account_name}</TableCell>
                      <TableCell><Badge className={`${tc.color} border-0 text-[10px]`}>{tc.label}</Badge></TableCell>
                      <TableCell className="text-center">{a.level}</TableCell>
                      <TableCell className="text-sm">{a.balance_direction === 'debit' ? '借' : '贷'}</TableCell>
                      <TableCell className="text-center">{a.is_detail ? '是' : '-'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{a.description || '-'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
