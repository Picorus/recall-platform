-- P5.8: invoices and credit notes on the brand portal.
-- RECALL's own legal name, GSTIN and address on documents are a setting (empty until registered).
ALTER TABLE settings DROP CONSTRAINT settings_key_check;
ALTER TABLE settings ADD CONSTRAINT settings_key_check CHECK (key IN
  ('cities', 'fittingCentres', 'support', 'messages', 'payZone', 'loanBank', 'riderSignIn',
   'brandSignIn', 'freeWeek', 'company'));

-- A GST number goes on an invoice only when it is safe to print (Prateek, 27 Oct 2026): set by
-- staff, or read from the GST records and on no other account. Otherwise the invoice is issued
-- without it, and the number held back and why are kept here for staff to settle.
ALTER TABLE gst_documents
  ADD COLUMN gstin_held     text CHECK (gstin_held ~ '^[0-9A-Z]{15}$'),
  ADD COLUMN gstin_held_why text CHECK (gstin_held_why IN ('typed', 'shared')),
  ADD CHECK ((gstin_held IS NULL) = (gstin_held_why IS NULL)),
  ADD CHECK (gstin IS NULL OR gstin_held IS NULL);
CREATE INDEX gst_documents_brand ON gst_documents (brand_id, issued_at);
