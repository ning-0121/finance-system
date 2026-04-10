// ============================================================
// 中文大写金额转换 — 严格财务规范
// 使用字符串分割避免浮点精度问题
// ============================================================

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const UNITS = ['', '拾', '佰', '仟']
const BIG_UNITS = ['', '万', '亿', '兆']

export function toChineseUppercase(amount: number): string {
  if (isNaN(amount) || !isFinite(amount)) return ''
  if (amount === 0) return '零元整'

  const negative = amount < 0
  const abs = Math.abs(amount)

  // 关键：用字符串处理避免浮点精度问题
  // 先转为分（整数），避免小数运算
  const totalFen = Math.round(abs * 100)
  const intPart = Math.floor(totalFen / 100)
  const jiao = Math.floor((totalFen % 100) / 10)
  const fen = totalFen % 10

  let result = negative ? '负' : ''

  // 整数部分
  if (intPart === 0) {
    if (jiao === 0 && fen === 0) return '零元整'
    // 没有元，只有角分
  } else {
    result += integerToChinese(intPart) + '元'
  }

  // 小数部分
  if (jiao === 0 && fen === 0) {
    result += '整'
  } else if (intPart === 0) {
    // 无元部分
    if (jiao === 0) {
      result += '零' + DIGITS[fen] + '分'
    } else if (fen === 0) {
      result += DIGITS[jiao] + '角整'
    } else {
      result += DIGITS[jiao] + '角' + DIGITS[fen] + '分'
    }
  } else {
    if (jiao === 0) {
      result += '零' + DIGITS[fen] + '分'
    } else if (fen === 0) {
      result += DIGITS[jiao] + '角整'
    } else {
      result += DIGITS[jiao] + '角' + DIGITS[fen] + '分'
    }
  }

  return result
}

function integerToChinese(n: number): string {
  if (n === 0) return DIGITS[0]

  const str = n.toString()
  const sections: number[] = []

  for (let i = str.length; i > 0; i -= 4) {
    const start = Math.max(0, i - 4)
    sections.unshift(parseInt(str.slice(start, i)))
  }

  let result = ''
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    const bigUnit = BIG_UNITS[sections.length - 1 - i]

    if (section === 0) {
      if (result && !result.endsWith('零')) result += '零'
      continue
    }

    if (result && section < 1000 && i > 0) {
      if (!result.endsWith('零')) result += '零'
    }

    result += sectionToChinese(section) + bigUnit
  }

  return result
}

function sectionToChinese(n: number): string {
  if (n === 0) return ''

  const digits = n.toString().split('').map(Number)
  let result = ''
  let prevZero = false

  for (let i = 0; i < digits.length; i++) {
    const d = digits[i]
    const unitIdx = digits.length - 1 - i

    if (d === 0) {
      prevZero = true
    } else {
      if (prevZero && result) result += '零'
      result += DIGITS[d] + UNITS[unitIdx]
      prevZero = false
    }
  }

  return result
}

// 金额格式化工具
export function formatAmount(value: number, decimals = 2): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// 精确四舍五入（避免浮点误差）
export function roundFinancial(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}
