# AR V2.1 bank import specification

The initial parser is deterministic and supports XLSX/CSV up to 10 MiB. It accepts Chinese or English aliases for transaction date, value date, debit, credit, amount, direction, currency, balance, counterparty, account, reference and memo.

Flow: select active internal account → upload → validate → parse preview → human confirmation → atomic RPC import → deterministic matching proposals.

Security and integrity:

- File names containing path separators or NUL are rejected; Chinese names are retained.
- Bank files are never exposed through a public URL.
- CSV date-only strings are parsed without timezone conversion.
- File SHA-256 prevents duplicate account/import combinations.
- Each transaction receives a SHA-256 fingerprint using bank account and external ID, or stable normalized financial fields.
- Row errors include the source row number. Confirmation fails while errors remain; preview still returns valid rows.
- Repeated confirmation is idempotent. No import creates a receipt or allocation automatically.
