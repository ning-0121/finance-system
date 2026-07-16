# AR V2.1 reconciliation rules

## Bank to receipt

Every credit is unmatched, suggested, partially/fully matched, duplicate, ignored with reason, or reversed. A bank transaction may create at most one active receipt.

## Receipt to application

`gross = approved order allocations + approved difference treatments + approved refunds + unapplied` within 0.01 currency units. Proposed/reversed rows do not count.

## Receivable to settlement

`original - approved adjustments = approved allocations + outstanding`, with approved overpayment represented as customer credit rather than unexplained negative outstanding.

## Order integration

Finance compares stable order ID, currency, amount and source version. Differences enter `receivable_source_revisions`; payment-active receivables are never silently overwritten.
