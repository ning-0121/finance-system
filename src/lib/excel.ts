// ============================================================
// Excel 导入导出工具
// ============================================================

import * as XLSX from 'xlsx'
import type { BudgetOrder } from '@/lib/types'

// --- 导出预算单列表为Excel ---
export function exportBudgetOrdersToExcel(orders: BudgetOrder[], filename?: string) {
  const data = orders.map(o => ({
    '订单号': o.order_no,
    '客户': o.customer?.company || '',
    '国家': o.customer?.country || '',
    '下单日期': o.order_date,
    '交货日期': o.delivery_date || '',
    '币种': o.currency,
    '汇率': o.exchange_rate,
    '总收入': o.total_revenue,
    '目标采购价': o.target_purchase_price,
    '预估运费': o.estimated_freight,
    '预估佣金': o.estimated_commission,
    '预估报关费': o.estimated_customs_fee,
    '其他费用': o.other_costs,
    '总成本': o.total_cost,
    '预计利润': o.estimated_profit,
    '毛利率(%)': o.estimated_margin,
    '状态': statusLabel(o.status),
    '备注': o.notes || '',
  }))

  const ws = XLSX.utils.json_to_sheet(data)

  // 设置列宽
  ws['!cols'] = [
    { wch: 18 }, { wch: 25 }, { wch: 8 }, { wch: 12 }, { wch: 12 },
    { wch: 6 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
    { wch: 10 }, { wch: 8 }, { wch: 30 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '预算单')
  XLSX.writeFile(wb, filename || `预算单导出_${new Date().toISOString().slice(0, 10)}.xlsx`)
}

// --- 导出单个订单详情为Excel ---
export function exportOrderDetailToExcel(order: BudgetOrder) {
  const wb = XLSX.utils.book_new()

  // Sheet 1: 订单概览
  const overview = [
    ['订单号', order.order_no],
    ['客户', order.customer?.company || ''],
    ['国家', order.customer?.country || ''],
    ['下单日期', order.order_date],
    ['交货日期', order.delivery_date || ''],
    ['币种', order.currency],
    ['汇率', order.exchange_rate],
    ['状态', statusLabel(order.status)],
    [''],
    ['收入与成本'],
    ['总收入', order.total_revenue],
    ['目标采购价', order.target_purchase_price],
    ['预估运费', order.estimated_freight],
    ['预估佣金', order.estimated_commission],
    ['预估报关费', order.estimated_customs_fee],
    ['其他费用', order.other_costs],
    ['总成本', order.total_cost],
    ['预计利润', order.estimated_profit],
    ['毛利率(%)', order.estimated_margin],
  ]
  const ws1 = XLSX.utils.aoa_to_sheet(overview)
  ws1['!cols'] = [{ wch: 15 }, { wch: 30 }]
  XLSX.utils.book_append_sheet(wb, ws1, '概览')

  // Sheet 2: 产品明细
  if (order.items?.length) {
    const items = order.items.map(item => ({
      'SKU': item.sku,
      '产品': item.product_name,
      '数量': item.qty,
      '单位': item.unit,
      '单价': item.unit_price,
      '金额': item.amount,
    }))
    const ws2 = XLSX.utils.json_to_sheet(items)
    ws2['!cols'] = [{ wch: 12 }, { wch: 25 }, { wch: 10 }, { wch: 6 }, { wch: 10 }, { wch: 12 }]
    XLSX.utils.book_append_sheet(wb, ws2, '产品明细')
  }

  XLSX.writeFile(wb, `${order.order_no}_详情.xlsx`)
}

// --- 解析导入的Excel文件（处理合并单元格、空行、公式） ---
export function parseImportedExcel(file: File): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, {
          type: 'array',
          cellFormula: false,   // 读取公式计算结果而非公式本身
          cellDates: true,      // 日期转为JS Date对象
          cellNF: true,         // 保留数字格式
        })
        const ws = wb.Sheets[wb.SheetNames[0]]

        // defval: '' 确保空单元格不被跳过
        // blankrows: false 跳过完全空白行
        const rows = XLSX.utils.sheet_to_json(ws, {
          defval: '',
          blankrows: false,
          raw: false,           // 格式化后的值（保持精度）
        }) as Record<string, unknown>[]

        // 过滤掉所有值都为空的行
        const filtered = rows.filter(row =>
          Object.values(row).some(v => v !== null && v !== undefined && v !== '')
        )

        resolve(filtered)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsArrayBuffer(file)
  })
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: '草稿', pending_review: '待审批', approved: '已通过', rejected: '已驳回', closed: '已关闭',
  }
  return map[status] || status
}
