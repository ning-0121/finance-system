'use client'

import { useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { confirmBankStatementImport, previewBankStatement } from './actions'

interface Account { id: string; label: string }

export function BankImportPanel({ accounts }: { accounts: Account[] }) {
  const input = useRef<HTMLInputElement>(null)
  const [accountId, setAccountId] = useState(accounts[0]?.id || '')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewBankStatement>> | null>(null)
  const [pending, startTransition] = useTransition()

  const formData = () => {
    const data = new FormData()
    const file = input.current?.files?.[0]
    if (file) data.set('file', file)
    data.set('bankAccountId', accountId)
    return data
  }

  return <div className="space-y-4 rounded-lg border p-4">
    <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
      <Select value={accountId} onValueChange={(value) => setAccountId(value || '')}>
        <SelectTrigger><SelectValue placeholder="选择公司收款账户" /></SelectTrigger>
        <SelectContent>{accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.label}</SelectItem>)}</SelectContent>
      </Select>
      <Input ref={input} type="file" accept=".xlsx,.csv" />
      <Button disabled={pending || !accountId} onClick={() => startTransition(async () => {
        const result = await previewBankStatement(formData())
        setPreview(result)
        if (!result.ok) toast.error(result.error)
      })}>预览解析</Button>
    </div>
    {preview?.ok && <div className="space-y-3 text-sm">
      <div>有效行 {preview.totalRows} · 重复文件校验码已生成 · 行错误 {preview.errors.length}</div>
      <div className="max-h-64 overflow-auto rounded border">
        <table className="w-full text-xs"><thead><tr><th>行</th><th>日期</th><th>方向</th><th>币种</th><th>金额</th><th>对方</th><th>摘要</th></tr></thead>
          <tbody>{preview.rows.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.transactionDate}</td><td>{row.direction}</td><td>{row.currency}</td><td>{row.amount}</td><td>{row.counterpartyName}</td><td>{row.memo}</td></tr>)}</tbody>
        </table>
      </div>
      <Button disabled={pending || preview.errors.length > 0} onClick={() => startTransition(async () => {
        const data = formData(); data.set('confirmed', 'true')
        const result = await confirmBankStatementImport(data)
        if (result.ok) toast.success('银行流水已导入，等待财务匹配')
        else toast.error(result.error)
      })}>确认导入（不会自动核销）</Button>
    </div>}
  </div>
}
