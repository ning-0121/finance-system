-- Read-only verification. Safe to run after an approved migration.
SELECT to_regclass('public.bank_statement_imports') AS bank_statement_imports,
       to_regclass('public.ar_adjustments') AS ar_adjustments,
       to_regclass('public.cash_application_batches') AS cash_application_batches,
       to_regclass('public.customer_statements') AS customer_statements;

SELECT indexname FROM pg_indexes
WHERE schemaname='public' AND indexname IN (
  'uq_bank_txn_normalized_fingerprint','uq_receivable_payment_idempotency',
  'uq_receivable_allocation_idempotency','idx_receivable_alloc_approval'
) ORDER BY indexname;

SELECT proname FROM pg_proc WHERE proname IN ('approve_ar_allocation','reverse_ar_allocation') ORDER BY proname;
