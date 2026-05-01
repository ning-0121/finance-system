# Phase A · 内部效率核心 — 迁移记录

本目录存放 Phase A 系列的所有数据库迁移脚本。每一阶段对应 3 个文件：`<阶段>-up.sql`（应用）、`<阶段>-down.sql`（回滚）、`<阶段>-verify.sql`（验收）。

## 工程纪律

1. **每个迁移必须有 down.sql**，且必须验证 apply → rollback → re-apply 三轮无残留
2. **不允许破坏现有功能** —— 旧表不动、旧逻辑不动
3. **shadow write 失败必须 try-catch**，不允许影响主业务路径
4. **不允许裸改旧核心业务逻辑**
5. **每个阶段必须能独立回滚**
6. **每次部署后必须跑 build / typecheck / 核心流程测试**

## 阶段进度

| 阶段 | 状态 | 内容 | 部署日期 |
|---|---|---|---|
| **A-0** | ✅ 已部署 | Safe Foundation：11 个新 schema + tenant 表 + qimo 默认租户 | 2026-04-27 |
| **A-1** | 🟢 准备就绪 | SoT Overlay：field_lineage + audit.events + sotWriteShadow + 字段来源 UI | — |
| A-2 | ⏸ 待 A-1 验收 | 异常中心 + 8 个简易扫描器 | — |
| A-3 | ⏸ 待 A-2 跑出真实异常 | Reconciliation Matrix（4 条核心规则） | — |

## A-1 部署前提条件

**重要**：A-1 涉及通过 PostgREST 调用新 schema 中的 RPC 与表，必须先把 `sot` 与 `audit` 暴露给 API：

```
Supabase Dashboard → Project Settings → API
→ Exposed schemas: 在原有 'public' 基础上追加 'sot' 和 'audit'
→ Save
```

如果忘了这一步，shadow write 会失败（被 try/catch 静默吞掉，不影响主业务）但 lineage 不会落库。验证方式：跑 `A-1-verify.sql` 第 4-8 项。

## 部署步骤（标准流程）

每个阶段的 SQL 必须按以下顺序执行：

```
1. 阅读 <阶段>-up.sql，确认变更范围
2. Supabase Dashboard → SQL Editor → New Query
3. 粘贴 <阶段>-up.sql → Run
4. 立即运行 <阶段>-verify.sql，逐条核对结果
5. 任一项验证失败：立即粘贴 <阶段>-down.sql → Run，回滚后排查
6. 全部通过：在本 README 表格中标记部署日期
```

## 回滚演练（强制要求）

任何 production 部署前，必须在测试 / staging 环境完成一轮：

```
A-0-up.sql → A-0-verify.sql (全绿) → A-0-down.sql → A-0-verify 验证 1 应返回 0 行 → A-0-up.sql (重新跑) → A-0-verify.sql (再次全绿)
```

确认幂等性 + 可回滚性后，才能 promote 到 production。
