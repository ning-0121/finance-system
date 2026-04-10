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
  'order:approve': ['admin', 'finance_manager'],
  'order:reject': ['admin', 'finance_manager'],
  'order:revoke': ['admin', 'finance_manager', 'finance_staff'],
  'cost:create': ['admin', 'finance_manager', 'finance_staff'],
  'cost:import': ['admin', 'finance_manager', 'finance_staff'],
  'report:export': ['admin', 'finance_manager', 'finance_staff'],
  'approval:view_queue': ['admin', 'finance_manager'],
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
  const rate = order.exchange_rate || 1
  const amountUSD = order.currency === 'USD'
    ? order.total_revenue
    : order.total_revenue / rate
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
