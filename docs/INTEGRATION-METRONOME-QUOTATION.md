# 节拍器 → 财务系统：报价单 (quotation) 推送规约

> 财务侧 Phase 3 Path A 已落地接收端（webhook + DB scaffolding）。
> 节拍器侧按本规约推送即可让预算单自动带 `_cost_breakdown`，免去财务人工补充。

## 触发场景

任意 `order.created` / `order.updated` webhook 事件，`data.order` 可携带 `quotation` 子对象。

## 字段规约

```ts
interface SyncedQuotation {
  fabric_amount?: number       // 面料  CNY
  accessory_amount?: number    // 辅料  CNY
  processing_amount?: number   // 加工费 CNY
  forwarder_amount?: number    // 货代  CNY
  container_amount?: number    // 装柜  CNY
  logistics_amount?: number    // 物流  CNY
  exchange_rate?: number       // 锁汇率 (USD→CNY)
  product_name?: string        // 品名（如 "瑜伽裤"）
  extras?: { name: string; amount: number }[]
  _source?: 'metronome_quotation'
  _quoted_at?: string          // ISO 8601
}
```

所有字段可选。**全空 = 不带报价**（财务侧仍创建 draft 但标记需人工补）。

## 完整 webhook 示例

```json
{
  "event": "order.created",
  "request_id": "req-20260420-001",
  "timestamp": "2026-04-20T08:00:00Z",
  "source": "order-metronome",
  "signature": "<HMAC-SHA256 of body>",
  "data": {
    "order": {
      "id": "uuid-v4",
      "order_no": "QM-20260420-001",
      "customer_name": "S2",
      "incoterm": "DDP",
      "po_number": "PO33301961",
      "currency": "USD",
      "total_amount": 79608,
      "quantity": 25680,
      "quantity_unit": "件",
      "factory_name": "傲狐",
      "etd": "2026-03-26",
      "quotation": {
        "fabric_amount": 197328,
        "accessory_amount": 25680,
        "processing_amount": 160500,
        "forwarder_amount": 70876.8,
        "container_amount": 500,
        "logistics_amount": 500,
        "exchange_rate": 6.82,
        "product_name": "瑜伽裤",
        "_source": "metronome_quotation",
        "_quoted_at": "2026-04-20T07:55:00Z"
      }
    }
  }
}
```

## 财务侧自动行为

收到带 `quotation` 的 webhook，自动：

1. 在 `budget_orders.items[0]._cost_breakdown` 写入 fabric/accessory/processing/forwarder/container/logistics
2. 汇总 `total_cost`、`estimated_profit`、`estimated_margin` 自动计算
3. `product_name` 写入 `budget_orders.product_name`（决算核算单"品名"行需要）
4. 原始 quotation 落档到 `synced_orders.quotation_data` (JSONB) + `quotation_applied_at` 时间戳
5. `budget_sync_status` 标为 `draft_created`（无 quotation 则为 `draft_created_no_quotation`）

## 验证

财务侧已通过回归测试（`tests/wave4b-phase3-quotation.test.ts` 14/14 ✓）覆盖：
- 含 quotation: `_cost_breakdown` 完整 + synced_orders 落档
- 无 quotation: 仍创建 draft + 标记
- 幂等性: 二次同 PO 不覆盖已有 breakdown

## 不要求节拍器侧做的

- 不需要送 `total_cost`（财务侧自算）
- 不需要送 `profit/margin`（财务侧自算）
- 不需要送 GL 凭证（财务侧自处理）
- 不需要 PDF/Excel 附件（财务可走 Path C OCR 路径单独上传）
