<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AI 治理铁律(老板 2026-07-06,不可违背)

这是生产财务系统、真实资金账。系统内的 AI(文档识别引擎、agent、比对/建议等)必须遵守:

1. **AI 不许自主写库** —— 任何 AI 抽取/判断的结果都不得直接 INSERT/UPDATE/RPC 写入财务数据。
2. **AI 只做建议·比对·警示(只读)** —— 可以把"待填入的值 / 比对差异 / 数据错误"展示给人;读多写零。
3. **AI 触发的建/改必须财务审批后才落库** —— 由**人(财务角色)**在 UI 审批,写入时记**真实 `auth.uid()`** 为审批人,绝不信任 AI/客户端传入的 actor。

落地要求:凡"AI 产出 → 落库"的路径,必须插一步财务审批(`requireRole` 财务角色 + 真实审批人留痕);
`auto_execute` 一律 false。既有的比对/警示功能(预算对照、历史采购价、查重弹窗、金额守恒校验)符合本律。
