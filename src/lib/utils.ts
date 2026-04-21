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
