# AR V2.1 deterministic matching engine

The engine ranks only open receivables in the bank transaction currency. Signals include exact order/reference, normalized customer/alias name, confirmed payer mapping, and exact outstanding amount. Results include customer, receivable IDs, proposed amount, remaining unapplied amount, evidence, conflicts and confidence.

High confidence requires combined evidence. Amount alone remains low confidence. Equal candidates from different customers become `needs_review`.

The engine never approves, posts or writes financial truth. `AI_MATCHING_POLICY` fixes `autoExecute=false`, `canApprove=false`, account masking, and proposal-only output. Any future AI agent runs after deterministic matching and must store provider/model/schema/usage plus accepted/rejected/edited outcome.
