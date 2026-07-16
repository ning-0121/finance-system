# AR V2.1 migration plan

Migration `20260716_ar_v21_reconciliation.sql` is additive and prepared only. It must not run in Production without a separate CEO approval.

1. Run SQL parser/safety checks and review grants/RLS in staging.
2. Snapshot table counts and active receipt/allocation totals by currency.
3. Apply migration in Preview/staging.
4. Run `20260716_ar_v21_reconciliation.verify.sql`.
5. Verify legacy `status IS NULL` allocations remain readable as approved with no backfill.
6. Compare pre/post received projections on synthetic fixtures.
7. Enable flags sequentially: bank import, allocations, statements; AI remains off.
8. Production migration requires a maintenance window, named approver and rollback decision tree.

No historical conversion or mass allocation is included. If conversion is later needed, create a dry-run duplicate report and obtain separate approval.
