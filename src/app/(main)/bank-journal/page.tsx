import { redirect } from 'next/navigation'

// 银行日记账已并入统一「银行」页（日记账 Tab）。保留此路由做重定向，兼容旧链接/书签。
export default function BankJournalRedirect() {
  redirect('/bank')
}
