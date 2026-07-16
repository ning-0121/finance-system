import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/server'
import { arFlags } from '@/lib/ar-v21/feature-flags'
import { bankAccountDisplay } from '@/lib/supabase/bank'
import { BankImportPanel } from './_bank-import-panel'

const modules = ['应收总览','银行流水','待匹配到账','回款登记','回款核销','未分配款','应收调整','客户对账单','对账异常','回款分析']

export default async function ArV21Page() {
  const enabled = arFlags.bankImport() || arFlags.allocations() || arFlags.statements()
  const supabase = await createClient()
  const { data: accounts } = await supabase.from('bank_accounts')
    .select('id,account_name,bank_name,account_number,currency,branch_name,legal_entity,account_purpose,is_active')
    .eq('is_active', true).order('account_name')
  const accountOptions = (accounts || []).map(account => ({ id: String(account.id), label: bankAccountDisplay(account) }))

  return <div className="flex min-h-screen flex-col">
    <Header title="应收 AR V2.1" subtitle="银行流水 · 回款核销 · 对账单" />
    <main className="space-y-6 p-6">
      {!enabled && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">AR V2.1 功能旗标关闭。数据库迁移和 Finance/CEO 上线审批完成前，现有应收真相不变。</div>}
      <div className="grid gap-3 md:grid-cols-5">{modules.map(module => <Card key={module}><CardContent className="p-4 font-medium">{module}</CardContent></Card>)}</div>
      <Card><CardHeader><CardTitle>1. 导入银行流水</CardTitle></CardHeader><CardContent>
        {arFlags.bankImport() ? <BankImportPanel accounts={accountOptions} /> : <p className="text-sm text-muted-foreground">AR_V21_BANK_IMPORT 未启用。</p>}
      </CardContent></Card>
      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader><CardTitle>待匹配到账</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">确定性建议只生成草稿；财务确认后才创建回款与分配。</CardContent></Card>
        <Card><CardHeader><CardTitle>未分配款</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">未分配余额按回款实时派生，不计入订单已收。</CardContent></Card>
        <Card><CardHeader><CardTitle>审批与冲销</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">分配、调整、退款和冲销均保留真实审批人与原因。</CardContent></Card>
      </div>
    </main>
  </div>
}
