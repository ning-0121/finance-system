// ============================================================
// 角色权限系统 — 方圆(录入/提交) + Su(审批)
// ============================================================

import type { UserRole, User, BudgetOrder } from '@/lib/types'

export type Permission =
  | 'order:create'
  | 'order:submit'
  | 'order:approve'
  | 'order:reject'
  | 'order:revoke'
  | 'cost:create'
  | 'cost:import'
  | 'report:export'
  | 'approval:view_queue'

const PERMISSION_MATRIX: Record<Permission, UserRole[]> = {
  'order:create': ['admin', 'finance_manager', 'finance_staff', 'sales'],
  'order:submit': ['admin', 'finance_manager', 'finance_staff'],
  'order:approve': ['admin', 'finance_manager', 'finance_staff'],
  'order:reject': ['admin', 'finance_manager', 'finance_staff'],
  'order:revoke': ['admin', 'finance_manager', 'finance_staff'],
  'cost:create': ['admin', 'finance_manager', 'finance_staff'],
  'cost:import': ['admin', 'finance_manager', 'finance_staff'],
  'report:export': ['admin', 'finance_manager', 'finance_staff'],
  'approval:view_queue': ['admin', 'finance_manager', 'finance_staff'],
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[permission]?.includes(role) ?? false
}

export function canApprove(user: User): boolean {
  return hasPermission(user.role, 'order:approve')
}

export function canSubmit(user: User): boolean {
  return hasPermission(user.role, 'order:submit')
}

export function canViewApprovalQueue(user: User): boolean {
  return hasPermission(user.role, 'approval:view_queue')
}

// 大额订单确认阈值
export const HIGH_VALUE_THRESHOLD_USD = 50000

export function requiresExtraConfirmation(order: BudgetOrder): boolean {
  // exchange_rate 是「原币→CNY」方向：先折 CNY，再按 USD 参考汇率折美元比阈值。
  // 此前非 USD 单用 total_revenue/rate 当美元——CNY 单(rate=1)整单被当美元(误报)、
  // EUR 单(rate≈7.8)被除小(大额漏报)，大额审批风控失真(审计 P1)。
  const rate = order.currency === 'CNY' ? 1 : (Number(order.exchange_rate) || 7)
  const amountCny = (Number(order.total_revenue) || 0) * rate
  const amountUSD = amountCny / 7   // USD 参考汇率，仅用于阈值判断
  return amountUSD > HIGH_VALUE_THRESHOLD_USD
}

export function getRoleLabel(role: UserRole): string {
  const labels: Record<UserRole, string> = {
    admin: '系统管理员',
    finance_manager: '财务总监',
    finance_staff: '财务',
    sales: '销售',
    procurement: '采购',
    cashier: '出纳',
  }
  return labels[role] || role
}
