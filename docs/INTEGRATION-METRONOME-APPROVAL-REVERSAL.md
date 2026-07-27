# 节拍器侧整改说明:接收审批「改判/撤销」回调(误批可撤销重审)

> 财务侧 2026-07-27 输出。配合财务侧新上线的「集成审批 · 撤销重审」功能(误批可改判)。
> 需节拍器侧确认/实现:能接收同一 approval 的**第二次、相反决定**的回调,并撤销之前按「批准」做的动作。

## 一、背景

财务侧新增了误批修正能力(集成审批「已处理」→「撤销重审」→ 重新驳回),用于纠正「本应驳回却误点批准」的价格/延期/里程碑/出货审批。

问题:当财务**先批准**(节拍器已据此放行,如价格闸门通过、下采购),**后改判为驳回**时,节拍器必须能**撤销之前的放行**,否则两系统会不一致(财务=已驳回,节拍器=已按批准推进)。

## 二、财务侧行为(现状,供对齐)

1. 财务撤销重审:`POST /api/integration/reopen` —— 仅把审批打回 `pending`(**财务内部,不回传节拍器**),留痕到 `integration_logs`。
2. 财务重新驳回:走既有 `POST /api/integration/approve` → `sendApprovalToMetronome`,向节拍器 `/api/integration/finance-callback` 发送:

```jsonc
{
  "event": "approval.callback",
  "request_id": "fin-approval-<type>-<approval_id>-rejected",   // 注意:与首次批准的 ...-approved 是【不同】request_id
  "data": {
    "approval_id": "<同一个 approval_id>",
    "approval_type": "price | delay | milestone | shipment | cancel",
    "decision": "rejected",              // ← 相反决定
    "decided_by": "<财务真实 uid>",
    "decider_name": "...",
    "decision_note": "撤销原因/驳回原因",
    "decided_at": "..."
  }
}
```

关键:**同一个 `approval_id` 会先后收到两条 `approval.callback`**:先 `decision:approved`,后 `decision:rejected`。两条 `request_id` 不同(尾缀 `-approved` / `-rejected`),所以**不会被节拍器的 request_id 幂等去重挡掉**——节拍器会真实收到第二条。

## 三、整改要求(节拍器侧)

1. **`finance-callback` 必须能处理「同一 approval_id 的、与之前相反的决定」**:收到 `decision:rejected` 而该 approval 之前已按 `approved` 放行时,**撤销/回滚之前的放行动作**(如:重新拦住价格闸门、撤回已触发的下采购/放行、把订单相应环节退回待处理)。
2. 不能因为「该 approval 已处理过」就静默忽略第二条回调。以 `data.decided_at` 或到达顺序为准,**后到的决定覆盖先到的**。
3. 回滚后建议回一个确认(或在节拍器侧留痕),便于财务核对改判是否已在节拍器生效。

## 四、当前待办的具体单

财务侧已发生一例:**601B 价格审批**误批(应驳回却点了批准,已回传节拍器 `approved`)。财务将走撤销重审→重新驳回,届时会发 `...-rejected` 回调。**请确认节拍器收到后能把 601B 的价格环节差回**;若暂不支持自动改判,需节拍器侧**人工撤销 601B 的放行**。

## 五、验证

节拍器实现后,财务对某误批单走「撤销重审→重新驳回」,节拍器应:①收到 `decision:rejected` 回调;②撤销该 approval 之前的放行;③该订单相应环节回到未放行/待处理。财务侧可在 `integration_logs`(event=`approval.reopened` + `approval.callback`)看到全链留痕。
