# AR V2.1 release readiness

## Implemented on branch

- Existing V2.0 truth reused; no duplicate receipt/allocation tables.
- Active bank-account master selector with legacy string compatibility.
- Additive schema/RPC preparation for audited imports, approvals, adjustments, treatments, refunds, statements, matching and revisions.
- Deterministic XLSX/CSV parser, fingerprinting and evidence-based matching.
- Decimal-safe settlement, reconciliation, customer statements and integration exceptions.
- Feature-gated AR V2.1 workspace and human confirmation.
- Synthetic financial, duplicate, reversal, multi-currency, timezone, RBAC, AI and migration-safety tests.

## Required before Production

- CEO approval to execute the prepared migration.
- Staging migration verification and receipt/allocation total reconciliation.
- Finance policy for rounding threshold, write-off limits, FX sources and self-approval separation.
- Authenticated employee workflow verification.
- Feature flags enabled one phase at a time.
- PDF renderer/security decision and AI provider privacy review before those flags are enabled.

Production migration, merge and deployment are explicitly out of scope without new approval.
