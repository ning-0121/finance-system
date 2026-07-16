# AR V2.1 allocation rules

- Operators propose; Finance managers/admins approve.
- Settlement uses only approved, non-reversed allocation amounts.
- Proposal amount must be positive and cannot exceed receipt availability.
- Order allocation cannot exceed outstanding unless a separately approved overpayment/customer-credit flow is selected.
- Mixed-currency allocation requires an approved exchange rate and CNY equivalent.
- Bank fee, rounding, customer deduction, credit note, refund and other differences use `receipt_difference_treatments`; they do not masquerade as order allocations.
- Unapplied cash is the exact derived remainder and is never counted as order settlement.
- Every creation/approval/reversal carries a database idempotency key.
- Reversal requires a reason and preserves the original row, actor and timestamps.

No rounding threshold is invented. A streamlined threshold remains disabled until Finance/CEO policy supplies a configured value.
