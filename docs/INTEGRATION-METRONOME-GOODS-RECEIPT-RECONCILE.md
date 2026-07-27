# 节拍器侧整改说明:收货核销(goods_receipt.recorded)对不上采购明细

> 财务侧审计 2026-07-27 输出。目的:让节拍器的「收货」能在财务侧自动核销到采购明细。
> 本文只描述节拍器侧需要做的事;财务侧匹配逻辑已就绪,无需财务改代码。

## 一、背景

财务侧 `fin_inbox_events` 里有 **11 条 `goods_receipt.recorded` 长期 pending**(2026-07-06 ~ 07-11),无法自动核销。原始数据未丢(都在 `fin_inbox_events`),但"按实收核销采购明细"这一步没做成。

涉及 3 个订单:

| order_id | 收货物料 | 情况 |
|---|---|---|
| `14cdaf91-…` | 280g直贡呢(面料)×2 | 财务侧**完全没有该订单的采购明细行** |
| `6b824c57-…` | 水洗标/中包袋/纸箱/主标/单包袋(辅料)×7 | 订单有部分明细,但这些**辅料行的 line_id 对不上** |
| `70b6a033-…` | 洗标/主标(辅料)×2 | 同上 |

**9/11 是辅料(标/袋/箱),2/11 是面料。** 完整清单见财务侧 `exports/goods_receipt_pending.csv`。

## 二、财务侧匹配逻辑(现状,供对齐)

`handleGoodsReceiptRecorded`(`src/app/api/integration/webhook/route.ts`):

1. **主匹配**:`fin_po_lines.line_id == goods_receipt.line_id` → 写入 `received_qty`,核销成功。
2. **兜底匹配**:`goods_receipt.po_no` → 查 `fin_purchase_orders.po_no` → 再按 `fin_po_lines(fin_po_id, material_name)` 匹配。
3. 两者都不中 → 事件留 `pending`(收货未核销,等重投/人工)。

而 `fin_po_lines`(财务的采购明细)由 **`purchase_order.placed`** 事件的 `data.lines[]` 填充(`onConflict: line_id`)。

## 三、根因(财务侧只读诊断)

- 财务 `fin_po_lines` **总共只有 14 行、只覆盖 4 个订单** → 绝大多数采购明细根本没同步到财务。
- 11 条收货的 `line_id` **全部不在** `fin_po_lines`(11/11)。
- 11 条收货的 `po_no` **全为空**(11/11)→ 兜底匹配(po_no + 料名)根本跑不起来,只能靠 line_id,而 line_id 又对不上。

## 四、整改要求(节拍器侧,按优先级)

1. **`purchase_order.placed` 必须为每张采购单发【全量】`lines[]`,含辅料/标/袋/箱等所有物料行**,每行带稳定的 `line_id`。
   现状看辅料行疑似缺失或未发 —— 有收货的订单在财务却没有对应辅料明细行。

2. **`goods_receipt.recorded.line_id` 必须与对应 `purchase_order.placed` 里该行的 `line_id` 完全一致**(同一套 id)。
   这是自动核销的**关键锚点**。若两个事件用了不同 id 体系,财务永远匹配不上。

3. **`goods_receipt.recorded` 补上 `po_no`**(当前为 null)。
   作为 line_id 对不上时的兜底锚点(po_no + material_name),多一层保险。

4. **时序**:先发 `purchase_order.placed`(建 `fin_po_lines`)再发 `goods_receipt.recorded`(核销)。
   若收货先到、明细后到,财务侧会留 pending 等重投 —— 补发明细后请**重推这 11 条收货事件**,财务即可自动核销。

## 五、契约字段

### `purchase_order.placed` → `data.lines[]`(每行,财务 `fin_po_lines` 需要)

| 字段 | 必填 | 说明 |
|---|---|---|
| `line_id` | ✅ | **核销锚点**,须与后续 goods_receipt 的 line_id 一致 |
| `order_id` / `order_no` | | 关联订单 |
| `material_name` | ✅ | 兜底匹配用 |
| `material_code` / `category` | | |
| `color` / `size` | | 同料多色按色核数量 |
| `supplier_name` / `supplier_id` | | 行级供应商 |
| `ordered_qty` / `ordered_unit` / `unit_price` / `amount` | | |

### `goods_receipt.recorded` → `data`(财务核销需要)

| 字段 | 必填 | 说明 |
|---|---|---|
| `line_id` | ✅ | 须与 `purchase_order.placed` 同一行的 line_id 一致 |
| `po_no` | ⚠️ **补** | 当前为 null;补上后可走兜底匹配 |
| `material_name` | ✅ | 兜底匹配用 |
| `received_qty_total` | ✅ | 实收总量 |
| `order_id` / `inspection_result` | | |

## 六、验证

节拍器侧补齐(1)(2)(3)后,重推这 11 条收货事件。财务侧对应 `fin_inbox_events` 记录应从 `pending` → `done`,reason 为「收货核销 line=… received=…」。财务侧可跑只读脚本复核剩余 pending 数(应归零)。

---
*财务侧联系:整改后如需财务侧协助重放存量 11 条,可提供 line_id 对齐后的映射,财务用已验证的签名重放流程回收。*
