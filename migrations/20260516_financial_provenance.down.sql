-- rollback: 20260516_financial_provenance
DROP TRIGGER IF EXISTS trg_record_provenance_journal_entries   ON public.journal_entries;
DROP TRIGGER IF EXISTS trg_record_provenance_payable_records   ON public.payable_records;
DROP TRIGGER IF EXISTS trg_record_provenance_actual_invoices   ON public.actual_invoices;
DROP TRIGGER IF EXISTS trg_record_provenance_order_settlements ON public.order_settlements;
DROP TRIGGER IF EXISTS trg_record_provenance_cost_items        ON public.cost_items;
DROP FUNCTION IF EXISTS public.trg_record_provenance();
DROP FUNCTION IF EXISTS public._fin_prov_affected_reports(text);
DROP FUNCTION IF EXISTS public._fin_prov_resolve_actor(text, uuid);
DROP TABLE IF EXISTS public.financial_provenance;
