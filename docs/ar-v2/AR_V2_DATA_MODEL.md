# AR V2 / V2.1 data model

Canonical chain:

`bank_accounts → bank_statement_imports → bank_transactions → receivable_payments → receivable_payment_allocations → budget_orders`

Supporting ledgers are `ar_adjustments`, `receipt_difference_treatments`, `ar_refunds`, `cash_application_batches`, `customer_statements`, `ar_matching_proposals`, `customer_payer_mappings`, and `receivable_source_revisions`.

`receivable_payments` remains receipt truth. `receivable_payment_allocations` remains order-allocation truth. A nullable legacy receipt `budget_order_id` is never used to calculate settlement.

## Formulas

`allocatable receipt = gross receipt - approved fee/difference treatments`

`net receivable = original receivable - approved AR adjustments`

`outstanding = net receivable - approved, non-reversed order allocations`

Unapplied cash is derived from the receipt reconciliation, not manually maintained. Reversed and proposed records remain visible but do not affect settled totals.

All database amounts use `numeric`; TypeScript calculations use `decimal.js`. Cross-currency allocations require rate, CNY equivalent, rate source/date, and approval metadata before rollout.
