# 节拍器侧契约:shipment.recorded(出运档案——提单/CI 文件推送)

> 财务侧 2026-07-28 输出,配合财务新页「出运档案」(/shipments)。财务侧接收端**已上线**。
> 目标:每一票货(=一张提单)在财务系统一站式调出 **提单 / CI / 客户PO / 决算单**。
> 前两者(提单/CI 文件)只有节拍器有 → 需按本契约在出运时推送。

## 一、事件

`POST` 到财务现有入站 webhook(与 order.created 同一个端点),鉴权同现有(`x-api-key` + `x-webhook-signature` HMAC + timestamp)。

```jsonc
{
  "event": "shipment.recorded",
  "source": "order-metronome",
  "timestamp": "2026-07-28T10:00:00Z",
  "request_id": "om-shipment.recorded-<hash>",
  "data": {
    "source_ref": "<节拍器 shipment id>",   // 幂等键(必填,重推=更新,不重复建)
    "bl_no": "MSKU1234567",                 // 提单号
    "ci_no": "CI-2026-071",                 // 商业发票号
    "shipping_port": "Shanghai",
    "destination_port": "Los Angeles",
    "etd": "2026-08-01",
    "carton_count": 320,
    "status": "shipped",                    // shipped | arrived | closed | cancelled(可选,默认 shipped)
    "notes": "",
    // 关联订单:一票可多单(合并出运)、一单可多票(分批)。qimo_order_id = 节拍器订单 uuid。
    "orders": [
      { "qimo_order_id": "14cdaf91-...", "order_no": "QM-20260703-021", "internal_order_no": "1022961" },
      { "qimo_order_id": "6b824c57-...", "order_no": "QM-20260717-002", "internal_order_no": "601B" }
    ],
    // 票面文件:提单/CI(PDF/图片)。file_url 用财务可长期访问的链接(公开 URL 或财务桶路径);
    // 若节拍器桶是私有短签名 URL,请改推【长期可用】的下载通道(与 file.uploaded 同一口径)。
    "attachments": [
      { "id": "ordoc-<uuid>", "file_name": "MSKU1234567-BL.pdf", "file_type": "pdf", "file_size": 102400, "file_url": "https://...", "doc_hint": "bl" },
      { "id": "ordoc-<uuid>", "file_name": "CI-2026-071.pdf",    "file_type": "pdf", "file_size": 98000,  "file_url": "https://...", "doc_hint": "ci" }
    ]
  }
}
```

## 二、字段要求

| 字段 | 必填 | 说明 |
|---|---|---|
| `source_ref` | ✅ | 节拍器 shipment id,幂等键。重推同 source_ref = 更新票头 + 补订单链接/附件(均不重复) |
| `bl_no` | 强烈建议 | 提单号(财务按它检索「每一票货」) |
| `orders[]` | ✅ | 该票覆盖的**全部**订单;`qimo_order_id` 必须是节拍器订单 uuid(财务用它解析到预算单/决算/客户PO) |
| `attachments[]` | 建议 | `doc_hint` 只认 `bl`(提单)/ `ci`(商业发票);`id` 带稳定 uuid(`ordoc-<uuid>` 形式可,财务会提取 uuid)防重复 |

## 三、财务侧行为(已上线,供对齐)

- 票头 upsert 进 `shipments`(按 source_ref 幂等);订单链接进 `shipment_orders`(多对多,自动解析 budget_order_id);文件进 `uploaded_documents`(挂 `related_shipment_id`,按 (票, file_url) 幂等)。
- 财务「出运档案」页(/shipments):按提单号/CI号/订单号搜票 → 一票展开即见 提单/CI 文件 + 各关联订单的 客户PO附件 + 决算单入口。
- 分批出运:同一订单第二票 = 新 source_ref 再推一条即可;合并出运:orders[] 放多个订单。

## 四、时序与验证

1. 建议在**出运确认/提单回来**时推送(文件齐了推一次;后补文件重推同 source_ref 即可)。
2. 验证:推一条测试票 → 财务 /shipments 应出现该票,点提单/CI 能打开,关联订单行能跳决算单。
3. 客户PO 附件继续走现有 `purchase_order.approval_requested attachments[]` / `file.uploaded`(带 order 关联),出运档案页会自动汇上来,无需重复推。
