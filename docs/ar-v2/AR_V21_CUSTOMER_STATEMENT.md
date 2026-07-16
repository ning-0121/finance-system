# AR V2.1 customer statement

Statements derive from approved receivables, adjustments, allocations, credit notes, refunds and reversals. They never maintain an independent balance.

Filters: customer, legal entity, currency, date range, open/all, PO, invoice, order and overdue status. Lines contain beginning balance, receivables, adjustments, allocations, credits, refunds and ending balance. Original currency and CNY equivalent are shown when available.

Generation produces a deterministic SHA-256 source snapshot hash and stores only metadata/file reference/status. Excel is the initial supported export. PDF remains gated until the existing document renderer is verified to preserve Chinese fonts and confidential storage.
