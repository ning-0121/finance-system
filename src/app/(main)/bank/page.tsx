'use client'

// ============================================================
// 银行（合并页）— 一个账户一屏看完
//   · 日记账 Tab：收付自动汇入 + 手工补录 + 逐笔余额（企业侧现金流水账）
//   · 对账   Tab：导入银行对账单 → 与回款/付款/关联往来逐笔对账 → 余额上锚
// 账户选择在本壳层共享，两个 Tab 同一账户上下文。
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, BookOpen, Scale } from 'lucide-react'
import { getJournalAccounts, ACCOUNT_TYPE_LABEL, type JournalAccount } from '@/lib/supabase/bank-journal'
import { JournalTab } from './_journal-tab'
import { ReconcileTab } from './_reconcile-tab'

export default function BankPage() {
  const [accounts, setAccounts] = useState<JournalAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'journal' | 'reconcile'>('journal')

  const reloadAccounts = useCallback(async () => {
    const accs = await getJournalAccounts()
    setAccounts(accs)
    setAccountId(prev => (prev && accs.some(a => a.id === prev)) ? prev : (accs.find(a => a.is_active)?.id || accs[0]?.id || ''))
  }, [])

  useEffect(() => { reloadAccounts().finally(() => setLoading(false)) }, [reloadAccounts])

  const account = accounts.find(a => a.id === accountId) || null
  // 账户下拉标签：账户名·类型（尾号4位）（Base UI SelectValue 默认回显 UUID，须显式给标签）
  const acctLabel = (a?: JournalAccount | null) => a
    ? `${a.account_name}${a.account_type ? '·' + ACCOUNT_TYPE_LABEL[a.account_type] : ''}${a.account_number ? '（' + a.account_number.replace(/\s/g, '').slice(-4) + '）' : ''}${!a.is_active ? ' [停用]' : ''}`
    : ''

  const onBalanceChange = (bal: number) => setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, current_balance: bal } : a))

  return (
    <div className="flex flex-col h-full">
      <Header title="银行" subtitle="日记账 · 逐笔余额 ｜ 对账 · 导入对账单 + 关联回款/付款/往来" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : accounts.length === 0 ? (
          <>
            <p className="text-sm text-muted-foreground">暂无银行账户 —— 点右侧「管理账户」新建一个（银行/支付宝/微信/现金）后即可使用。</p>
            <JournalTab accountId="" account={null} accounts={accounts} reloadAccounts={reloadAccounts} />
          </>
        ) : (
          <>
            {/* 共享账户 + Tab 切换 */}
            <div className="flex items-center gap-3 flex-wrap">
              <Select value={accountId} onValueChange={v => { if (v) setAccountId(v) }}>
                <SelectTrigger className="w-[300px]"><SelectValue placeholder="选择账户">{(id) => acctLabel(accounts.find(a => a.id === id))}</SelectValue></SelectTrigger>
                <SelectContent>
                  {accounts.map(a => <SelectItem key={a.id} value={a.id}>{acctLabel(a)}</SelectItem>)}
                </SelectContent>
              </Select>
              {account && <Badge variant="outline" className="text-sm">{account.currency}</Badge>}
              <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)} className="ml-auto">
                <TabsList>
                  <TabsTrigger value="journal"><BookOpen className="h-4 w-4 mr-1" />日记账</TabsTrigger>
                  <TabsTrigger value="reconcile"><Scale className="h-4 w-4 mr-1" />对账</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {tab === 'journal'
              ? <JournalTab accountId={accountId} account={account} accounts={accounts} reloadAccounts={reloadAccounts} />
              : <ReconcileTab accountId={accountId} currentBalance={account?.current_balance} onBalanceChange={onBalanceChange} />}
          </>
        )}
      </div>
    </div>
  )
}
