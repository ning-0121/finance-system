import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 转义 SQL ILIKE 模式中的特殊字符（%, _, \），防止通配符扩大查询范围。
 * 使用方式: supabase.from('t').ilike('col', `%${escapeIlike(userInput)}%`)
 */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

/**
 * 归一化供应商名称，用于跨模块匹配（费用归集 cost_items.supplier ↔
 * 供应商付款 supplier_payments.supplier_name）。
 *
 * 财务系统里两张表的供应商名都是自由文本、无外键。常见的「看着一样、
 * 其实不等」差异会导致付款无法冲抵费用（对账单虚增/虚减）：
 *   - 尾随/前导/重复空格："义乌绮陌 " ≠ "义乌绮陌"
 *   - 全角/半角：全角空格、全角括号（）、全角字母Ａ vs A
 *   - 不可见字符
 *
 * 这里用 NFKC 把全角统一成半角，再把任意空白折叠成单个半角空格并去首尾，
 * 得到一个稳定的「显示名 + 匹配键」二合一结果。
 * 注意：不做大小写折叠/拼写纠错——那会错误合并真正不同的供应商。
 */
export function normalizeSupplierName(s: string | null | undefined): string {
  if (!s) return ''
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

// 客户名归一化（与供应商同口径）：NFKC 折叠全/半角 + 压缩空格 + trim。
// 用于应收分组、回款→订单匹配，避免同一客户因全半角/空格差异被拆行或匹配不上。
export function normalizeCustomerName(s: string | null | undefined): string {
  if (!s) return ''
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim()
}
