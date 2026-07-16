-- QIMO Finance OS · AR V2.1 additive foundation
-- PREPARE ONLY. Do not execute in Production without explicit CEO approval.
-- Safety: additive DDL only; no DROP/DELETE/TRUNCATE; no historical backfill.

BEGIN;

CREATE TABLE IF NOT EXISTS public.bank_statement_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  source_filename text NOT NULL,
  file_checksum text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('xlsx','csv')),
  statement_period_start date,
  statement_period_end date,
  imported_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  imported_at timestamptz NOT NULL DEFAULT now(),
  parser_version text NOT NULL,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  duplicate_row_count integer NOT NULL DEFAULT 0 CHECK (duplicate_row_count >= 0),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','parsing','needs_review','completed','failed','superseded')),
  error_code text,
  error_message text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, file_checksum),
  UNIQUE (idempotency_key)
);

ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES public.bank_statement_imports(id) ON DELETE RESTRICT;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS external_transaction_id text;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS value_date date;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS counterparty_account_masked text;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS normalized_fingerprint text;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS review_status text;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS raw_row_number integer;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS reversed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS reversal_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_txn_normalized_fingerprint
  ON public.bank_transactions(bank_account_id, normalized_fingerprint)
  WHERE normalized_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_txn_v21_review
  ON public.bank_transactions(match_status, review_status, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_import_review
  ON public.bank_statement_imports(status, imported_at DESC);

ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS legal_entity text;
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS account_purpose text;
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS branch_name text;
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS remarks text;

ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS bank_transaction_id uuid REFERENCES public.bank_transactions(id) ON DELETE RESTRICT;
ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS approval_status text;
ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS source_version integer;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receivable_payment_idempotency
  ON public.receivable_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receivable_payment_bank_txn
  ON public.receivable_payments(bank_transaction_id) WHERE bank_transaction_id IS NOT NULL AND voided_at IS NULL;

ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS allocation_type text;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS allocation_currency text;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8);
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS allocated_cny numeric(15,2);
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS proposed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.receivable_payment_allocations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS uq_receivable_allocation_idempotency
  ON public.receivable_payment_allocations(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receivable_alloc_approval
  ON public.receivable_payment_allocations(status, created_at DESC) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS public.ar_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_order_id uuid NOT NULL REFERENCES public.budget_orders(id) ON DELETE RESTRICT,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('bank_fee','rounding','customer_deduction','commercial_discount','quality_claim','bad_debt','write_off','fx_difference','credit_note','other')),
  amount_original numeric(15,2) NOT NULL CHECK (amount_original > 0),
  currency text NOT NULL,
  exchange_rate numeric(18,8),
  amount_cny numeric(15,2) NOT NULL CHECK (amount_cny > 0),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','reversed')),
  reason text NOT NULL,
  evidence_reference text,
  proposed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  reversed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  reversal_reason text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ar_adjustments_review ON public.ar_adjustments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_adjustments_order ON public.ar_adjustments(budget_order_id, status);

CREATE TABLE IF NOT EXISTS public.cash_application_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  receipt_id uuid NOT NULL REFERENCES public.receivable_payments(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','pending_approval','approved','rejected','reversed')),
  proposed_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (proposed_total >= 0),
  approved_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (approved_total >= 0),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  review_note text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ar_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.receivable_payments(id) ON DELETE RESTRICT,
  amount_original numeric(15,2) NOT NULL CHECK (amount_original > 0),
  currency text NOT NULL,
  amount_cny numeric(15,2) NOT NULL CHECK (amount_cny > 0),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','reversed')),
  reason text NOT NULL,
  proposed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  reversed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  reversal_reason text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.receipt_difference_treatments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.receivable_payments(id) ON DELETE RESTRICT,
  treatment_type text NOT NULL CHECK (treatment_type IN ('bank_fee','rounding','customer_deduction','credit_note','unapplied','refund','other')),
  amount_original numeric(15,2) NOT NULL CHECK (amount_original > 0),
  currency text NOT NULL,
  exchange_rate numeric(18,8),
  amount_cny numeric(15,2) NOT NULL CHECK (amount_cny > 0),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','reversed')),
  reason text NOT NULL,
  proposed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  reversed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  reversal_reason text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receipt_treatment_review ON public.receipt_difference_treatments(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.customer_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  legal_entity text,
  statement_period_start date NOT NULL,
  statement_period_end date NOT NULL,
  currency text NOT NULL,
  generated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  generated_at timestamptz NOT NULL DEFAULT now(),
  source_snapshot_hash text NOT NULL,
  file_reference text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','superseded','cancelled')),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (statement_period_end >= statement_period_start)
);
CREATE INDEX IF NOT EXISTS idx_customer_statements_lookup ON public.customer_statements(customer_id, currency, statement_period_end DESC);

CREATE TABLE IF NOT EXISTS public.ar_matching_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE RESTRICT,
  proposal_source text NOT NULL CHECK (proposal_source IN ('deterministic','ai')),
  suggested_customer_id uuid,
  suggested_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low','needs_review')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  remaining_unapplied numeric(15,2) NOT NULL DEFAULT 0,
  provider text,
  model text,
  prompt_schema_version text,
  usage_metadata jsonb,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','edited','rejected','superseded')),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customer_payer_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  normalized_payer_name text,
  counterparty_account_masked text,
  confirmed_count integer NOT NULL DEFAULT 1 CHECK (confirmed_count > 0),
  confirmed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','disputed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (customer_id, normalized_payer_name, counterparty_account_masked)
);

CREATE TABLE IF NOT EXISTS public.receivable_source_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_order_id uuid NOT NULL REFERENCES public.budget_orders(id) ON DELETE RESTRICT,
  source_system text NOT NULL,
  source_version integer NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  previous_amount numeric(15,2),
  revised_amount numeric(15,2) NOT NULL,
  currency text NOT NULL,
  payment_activity_exists boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected','applied')),
  source_payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  UNIQUE (budget_order_id, source_version)
);

-- All new financial tables are readable by authenticated users and have no direct
-- client write policies. Mutations must use role-checking SECURITY DEFINER RPCs.
DO $policy$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'bank_statement_imports','ar_adjustments','cash_application_batches','ar_refunds','receipt_difference_treatments',
    'customer_statements','ar_matching_proposals','customer_payer_mappings','receivable_source_revisions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=table_name AND policyname=table_name || '_read') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', table_name || '_read', table_name);
    END IF;
  END LOOP;
END $policy$;

CREATE OR REPLACE FUNCTION public.commit_ar_bank_import(
  p_bank_account_id uuid, p_source_filename text, p_file_checksum text, p_file_type text,
  p_parser_version text, p_idempotency_key text, p_rows jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_role text := COALESCE(public._app_role(),'none'); v_import uuid; v_row jsonb; v_inserted integer := 0; v_duplicates integer := 0;
BEGIN
  IF v_actor IS NULL OR v_role NOT IN ('finance_staff','finance_manager','admin') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_file_type NOT IN ('xlsx','csv') OR jsonb_typeof(p_rows)<>'array' THEN RAISE EXCEPTION 'INVALID_IMPORT_PAYLOAD'; END IF;
  SELECT id INTO v_import FROM public.bank_statement_imports WHERE idempotency_key=p_idempotency_key OR (bank_account_id=p_bank_account_id AND file_checksum=p_file_checksum) LIMIT 1;
  IF v_import IS NOT NULL THEN RETURN jsonb_build_object('import_id',v_import,'idempotent',true); END IF;
  INSERT INTO public.bank_statement_imports(bank_account_id,source_filename,file_checksum,file_type,imported_by,parser_version,row_count,status,idempotency_key)
  VALUES(p_bank_account_id,p_source_filename,p_file_checksum,p_file_type,v_actor,p_parser_version,jsonb_array_length(p_rows),'parsing',p_idempotency_key)
  RETURNING id INTO v_import;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    INSERT INTO public.bank_transactions(
      import_id,bank_account_id,txn_date,value_date,direction,currency,amount,balance_after,counterparty,
      counterparty_account_masked,reference,summary,raw_row_number,normalized_fingerprint,dedup_key,import_batch,created_by,review_status
    ) VALUES (
      v_import,p_bank_account_id,(v_row->>'transactionDate')::date,NULLIF(v_row->>'valueDate','')::date,
      CASE v_row->>'direction' WHEN 'credit' THEN 'in' ELSE 'out' END, v_row->>'currency',(v_row->>'amount')::numeric,
      NULLIF(v_row->>'balance','')::numeric,NULLIF(v_row->>'counterpartyName',''),NULLIF(v_row->>'counterpartyAccountMasked',''),
      NULLIF(v_row->>'reference',''),NULLIF(v_row->>'memo',''),(v_row->>'rowNumber')::integer,v_row->>'fingerprint',
      v_row->>'fingerprint',v_import::text,v_actor,'needs_review'
    ) ON CONFLICT DO NOTHING;
    IF FOUND THEN v_inserted := v_inserted + 1; ELSE v_duplicates := v_duplicates + 1; END IF;
  END LOOP;
  UPDATE public.bank_statement_imports SET status=CASE WHEN v_inserted=0 THEN 'needs_review' ELSE 'completed' END,duplicate_row_count=v_duplicates WHERE id=v_import;
  RETURN jsonb_build_object('import_id',v_import,'inserted',v_inserted,'duplicates',v_duplicates,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public._refresh_order_ar_projection(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cny numeric; v_last date; v_rate numeric;
BEGIN
  SELECT COALESCE(SUM(a.amount_cny),0), MAX(p.received_at)
    INTO v_cny, v_last
  FROM public.receivable_payment_allocations a
  JOIN public.receivable_payments p ON p.id = a.receipt_id
  WHERE a.budget_order_id = p_order_id
    AND a.voided_at IS NULL AND p.voided_at IS NULL
    AND COALESCE(a.status, 'approved') = 'approved';
  SELECT COALESCE(NULLIF(exchange_rate,0),1) INTO v_rate FROM public.budget_orders WHERE id = p_order_id;
  IF v_rate IS NULL THEN RETURN; END IF;
  UPDATE public.budget_orders SET ar_received_amount = round(v_cny / v_rate, 2), ar_received_at = v_last, updated_at = now() WHERE id = p_order_id;
END $$;

CREATE OR REPLACE FUNCTION public._recalc_receipt_match(p_receipt_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amount numeric; v_status text; v_voided timestamptz; v_alloc numeric;
BEGIN
  SELECT amount_cny, matched_status, voided_at INTO v_amount, v_status, v_voided FROM public.receivable_payments WHERE id = p_receipt_id FOR UPDATE;
  IF v_amount IS NULL OR v_voided IS NOT NULL OR v_status = 'disputed' THEN RETURN; END IF;
  SELECT COALESCE(SUM(amount_cny),0) INTO v_alloc FROM public.receivable_payment_allocations
   WHERE receipt_id = p_receipt_id AND voided_at IS NULL AND COALESCE(status, 'approved') = 'approved';
  UPDATE public.receivable_payments SET matched_status = CASE
    WHEN v_alloc <= 0.005 THEN 'unmatched' WHEN v_alloc + 0.005 < v_amount THEN 'partially_matched' ELSE 'matched' END,
    updated_at = now() WHERE id = p_receipt_id;
END $$;

CREATE OR REPLACE FUNCTION public.approve_ar_allocation(p_allocation_id uuid, p_idempotency_key text, p_review_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_role text := COALESCE(public._app_role(),'none'); v_order uuid; v_receipt uuid; v_status text;
BEGIN
  IF v_actor IS NULL OR v_role NOT IN ('finance_manager','admin') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NULLIF(trim(p_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  SELECT budget_order_id, receipt_id, COALESCE(status,'approved') INTO v_order, v_receipt, v_status
    FROM public.receivable_payment_allocations WHERE id=p_allocation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ALLOCATION_NOT_FOUND'; END IF;
  IF v_status='approved' THEN RETURN jsonb_build_object('allocation_id',p_allocation_id,'status','approved','idempotent',true); END IF;
  IF v_status<>'proposed' THEN RAISE EXCEPTION 'ALLOCATION_NOT_APPROVABLE'; END IF;
  UPDATE public.receivable_payment_allocations SET status='approved', approved_by=v_actor, approved_at=now(), updated_at=now()
   WHERE id=p_allocation_id;
  PERFORM public._refresh_order_ar_projection(v_order);
  PERFORM public._recalc_receipt_match(v_receipt);
  INSERT INTO public.entity_timeline(entity_type,entity_id,event_type,event_title,event_detail,source_type,actor_id)
  VALUES('receivable_payment',v_receipt,'allocation_approved','回款分配审批',jsonb_build_object('allocation_id',p_allocation_id,'idempotency_key',p_idempotency_key,'note',p_review_note),'human',v_actor);
  RETURN jsonb_build_object('allocation_id',p_allocation_id,'status','approved');
END $$;

CREATE OR REPLACE FUNCTION public.reverse_ar_allocation(p_allocation_id uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_role text := COALESCE(public._app_role(),'none'); v_order uuid; v_receipt uuid; v_status text;
BEGIN
  IF v_actor IS NULL OR v_role NOT IN ('finance_manager','admin') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'REVERSAL_REASON_REQUIRED'; END IF;
  SELECT budget_order_id,receipt_id,COALESCE(status,'approved') INTO v_order,v_receipt,v_status
    FROM public.receivable_payment_allocations WHERE id=p_allocation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ALLOCATION_NOT_FOUND'; END IF;
  IF v_status='reversed' THEN RETURN jsonb_build_object('allocation_id',p_allocation_id,'status','reversed','idempotent',true); END IF;
  IF v_status<>'approved' THEN RAISE EXCEPTION 'ONLY_APPROVED_ALLOCATION_CAN_REVERSE'; END IF;
  UPDATE public.receivable_payment_allocations SET status='reversed',voided_at=now(),voided_by=v_actor,void_reason=p_reason,updated_at=now()
   WHERE id=p_allocation_id;
  PERFORM public._refresh_order_ar_projection(v_order);
  PERFORM public._recalc_receipt_match(v_receipt);
  INSERT INTO public.entity_timeline(entity_type,entity_id,event_type,event_title,event_detail,source_type,actor_id)
  VALUES('receivable_payment',v_receipt,'allocation_reversed','回款分配冲销',jsonb_build_object('allocation_id',p_allocation_id,'reason',p_reason,'idempotency_key',p_idempotency_key),'human',v_actor);
  RETURN jsonb_build_object('allocation_id',p_allocation_id,'status','reversed');
END $$;

REVOKE ALL ON FUNCTION public.approve_ar_allocation(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_ar_allocation(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_ar_bank_import(uuid,text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_ar_allocation(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_ar_allocation(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_ar_bank_import(uuid,text,text,text,text,text,jsonb) TO authenticated;

COMMIT;
