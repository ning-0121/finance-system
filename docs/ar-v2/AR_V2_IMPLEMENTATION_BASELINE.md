# AR V2.0 implementation baseline

Audited on 2026-07-16 against Finance OS `ac426f6`. Order Metronome was inspected only for its read-only integration contract.

## Implemented

| Capability | Existing truth |
|---|---|
| Receivable source | `budget_orders.total_revenue`, approved/closed orders; `synced_orders` supplies cross-system identifiers |
| Multiple receipts | `receivable_payments`; one row per actual receipt |
| Many-to-many settlement | `receivable_payment_allocations(receipt_id,budget_order_id)`; `receivable_payments.budget_order_id` is explicitly a legacy quick link |
| Received projection | `_refresh_order_ar_projection`; approved active allocation totals are authoritative, `budget_orders.ar_received_amount` is a cache |
| Partial/full receipt status | `_recalc_receipt_match` and `matched_status` |
| Receipt bank account | `receivable_payments.bank_account_id` plus legacy `bank_account` display text |
| Bank ledger | `bank_accounts`, `bank_transactions`, bank journal and reconciliation UI |
| Duplicate controls | receipt reference uniqueness and `(bank_account_id,dedup_key)` bank-line uniqueness |
| Reversal | allocations and receipts are voided with actor, time and reason; no ordinary hard delete |
| Role enforcement | Finance roles in RLS/RPCs; later actor-guard migrations use `auth.uid()` |
| Multi-currency | original amount, currency, exchange rate and CNY amount on receipts/allocations |

## Partial

- Existing allocations become effective immediately through the legacy RPC. V2.1 adds proposed/approved/reversed status without rewriting historical rows.
- Existing bank import writes rows directly from the authenticated client and records only `import_batch`; V2.1 adds audited import headers and server-controlled confirmation.
- Existing matching is exact-amount/date/name oriented. It is deterministic but returns no structured evidence/conflicts.
- Bank account selection historically derives strings from prior orders. V2.1 also loads the active account master and persists `bank_account_id` when selected.
- Existing `writeOffReceivable` is not a full adjustment ledger. V2.1 adds adjustment proposals and approvals.
- Existing bank reconciliation is one bank line to one receipt/payment/manual entry. Cash application remains a separate receipt-to-order layer.

## Missing before this branch

- Audited bank import batches and row-level parse errors.
- Approval-state allocations and separate receipt difference treatments.
- First-class derived unapplied cash queue.
- Deterministic matching proposals with evidence/conflicts.
- Customer statement snapshot metadata and source hash.
- Receivable revision exceptions after payment activity.
- AR V2.1 feature flags and consolidated workspace.

## Compatibility constraints

- Never duplicate `receivable_payments` or `receivable_payment_allocations`.
- `status IS NULL` on a legacy allocation means approved unless `voided_at` is set. No Production backfill is part of V2.1.
- Legacy `bank_account` and quick-link `budget_order_id` remain readable.
- Existing projections must count only approved allocations after V2.1, while treating legacy null status as approved.
- Order Metronome owns commercial order truth; Finance owns receipt, allocation, adjustment, reconciliation and settlement truth.
- Current Order Metronome pull API provides stable order IDs/numbers and updated timestamps, but source-version/idempotency fields need a separately versioned contract enhancement.
