-- P1.7.9: GST and the books. Each brand's tax details (latest wins), and every tax invoice and
-- credit note, numbered in one unbroken series per financial year. Append-only (hard rule 3).
CREATE TABLE brand_tax_profiles (
  brand_id   text        NOT NULL CHECK (length(brand_id) BETWEEN 1 AND 64),
  set_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  legal_name text        NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 200),
  gstin      text        CHECK (gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code text        NOT NULL CHECK (state_code ~ '^\d{2}$'),
  address    text        NOT NULL DEFAULT '',
  set_by     text        NOT NULL,
  PRIMARY KEY (brand_id, set_at),
  CHECK (gstin IS NULL OR left(gstin, 2) = state_code)
);

CREATE TABLE gst_documents (
  doc_no          text        PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('invoice', 'credit-note')),
  fy              text        NOT NULL CHECK (fy ~ '^\d{4}-\d{2}$'),
  n               integer     NOT NULL CHECK (n > 0),
  -- The ledger entry it belongs to: one document per entry, never two.
  source_entry    text        NOT NULL UNIQUE REFERENCES ledger_entries (entry_id),
  booking_id      text        NOT NULL REFERENCES bookings (booking_id),
  brand_id        text        NOT NULL,
  against_doc     text        REFERENCES gst_documents (doc_no),
  legal_name      text        NOT NULL,
  gstin           text,
  place_of_supply text        NOT NULL CHECK (place_of_supply ~ '^\d{2}$'),
  -- The service code printed on the document (advertising: 998365, a setting).
  sac             text        NOT NULL CHECK (sac ~ '^\d{6}$'),
  taxable_paise   bigint      NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise      bigint      NOT NULL CHECK (cgst_paise >= 0),
  sgst_paise      bigint      NOT NULL CHECK (sgst_paise >= 0),
  igst_paise      bigint      NOT NULL CHECK (igst_paise >= 0),
  total_paise     bigint      NOT NULL,
  issued_at       timestamptz NOT NULL,
  UNIQUE (kind, fy, n),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  CHECK ((kind = 'credit-note') = (against_doc IS NOT NULL))
);
CREATE INDEX gst_documents_issued ON gst_documents (issued_at);

-- Invoices partners (agencies, aggregators) send RECALL for their cuts. Their GST is claimed back
-- only when such an invoice is recorded (best practice, Prateek 25 Oct 2026: no CA yet).
CREATE TABLE partner_invoices (
  partner_id    text        NOT NULL CHECK (length(partner_id) BETWEEN 1 AND 64),
  invoice_no    text        NOT NULL CHECK (length(invoice_no) BETWEEN 1 AND 16),
  invoice_date  date        NOT NULL,
  gstin         text        CHECK (gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  taxable_paise bigint      NOT NULL CHECK (taxable_paise > 0),
  gst_paise     bigint      NOT NULL CHECK (gst_paise >= 0),
  recorded_by   text        NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, invoice_no),
  CHECK (gst_paise = 0 OR gstin IS NOT NULL)
);
CREATE TRIGGER partner_invoices_no_change BEFORE UPDATE OR DELETE ON partner_invoices
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER partner_invoices_no_truncate BEFORE TRUNCATE ON partner_invoices
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE TRIGGER brand_tax_profiles_no_change BEFORE UPDATE OR DELETE ON brand_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_tax_profiles_no_truncate BEFORE TRUNCATE ON brand_tax_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER gst_documents_no_change BEFORE UPDATE OR DELETE ON gst_documents
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER gst_documents_no_truncate BEFORE TRUNCATE ON gst_documents
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON brand_tax_profiles, gst_documents, partner_invoices TO recall_app;
