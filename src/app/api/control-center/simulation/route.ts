// 模拟推演 API
// GET /api/control-center/simulation
// POST /api/control-center/simulation
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  getSavedScenarios,
  simulateFxChange,
  simulateCostIncrease,
  simulateCustomerLoss,
  simulateSupplyDisruption,
  saveScenario,
} from '@/lib/engines/simulation-engine'

export async function GET() {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const data = await getSavedScenarios()
    return NextResponse.json({ data })
  } catch (error) {
    console.error('[simulation GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取模拟场景失败' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    const body = await request.json()
    const { action, scenarioType, parameters } = body

    // 保存场景
    if (action === 'save') {
      const { name, scenarioType: type, parameters: params, result } = body
      if (!name || !type || !params || !result) {
        return NextResponse.json(
          { error: '缺少 name、scenarioType、parameters 或 result' },
          { status: 400 }
        )
      }
      const id = await saveScenario(name, type, params, result, auth.userId!)
      return NextResponse.json({ data: { id } })
    }

    // 运行模拟
    if (!scenarioType || !parameters) {
      return NextResponse.json(
        { error: '缺少 scenarioType 或 parameters' },
        { status: 400 }
      )
    }

    switch (scenarioType) {
      case 'fx_change': {
        const { newRate } = parameters
        if (newRate == null) {
          return NextResponse.json({ error: '缺少 parameters.newRate' }, { status: 400 })
        }
        const result = await simulateFxChange(newRate)
        return NextResponse.json({ data: result })
      }

      case 'cost_increase': {
        const { costType, percent } = parameters
        if (!costType || percent == null) {
          return NextResponse.json(
            { error: '缺少 parameters.costType 或 parameters.percent' },
            { status: 400 }
          )
        }
        const result = await simulateCostIncrease(costType, percent)
        return NextResponse.json({ data: result })
      }

      case 'customer_loss': {
        const { customerId } = parameters
        if (!customerId) {
          return NextResponse.json({ error: '缺少 parameters.customerId' }, { status: 400 })
        }
        const result = await simulateCustomerLoss(customerId)
        return NextResponse.json({ data: result })
      }

      case 'supply_disruption': {
        const { supplierName } = parameters
        if (!supplierName) {
          return NextResponse.json({ error: '缺少 parameters.supplierName' }, { status: 400 })
        }
        const result = await simulateSupplyDisruption(supplierName)
        return NextResponse.json({ data: result })
      }

      default:
        return NextResponse.json({ error: `未知场景类型: ${scenarioType}` }, { status: 400 })
    }
  } catch (error) {
    console.error('[simulation POST]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '模拟推演失败' },
      { status: 500 }
    )
  }
}
