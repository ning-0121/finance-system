# AR V2.1 KPI definitions

- Collection rate: approved allocations in period / net receivables due in period.
- DSO: ending approved outstanding / credit sales for period × calendar days.
- Overdue aging: approved outstanding grouped by days after due date: current, 1–30, 31–60, 61–90, 90+.
- Unapplied aging: receipt allocatable remainder grouped by days since receipt.
- Deduction totals: approved `customer_deduction` treatments by customer/reason/order owner.
- Bank fee totals: approved `bank_fee` treatments by currency/account.
- Matching time: approval timestamp minus bank-transaction import timestamp.
- Suggestion acceptance rate: accepted deterministic/AI proposals / reviewed proposals.
- Reversal rate: reversed approved allocations / approved allocations.

All KPI amounts are grouped by currency unless an explicit approved CNY conversion basis is present.
