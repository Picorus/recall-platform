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
-- What was printed, kept as it was on the day (a document never changes, even when RECALL's details
-- or the GST rate do later): RECALL's details from the company setting (empty before registration:
-- then never a valid tax invoice), the GST rate of the booking's price book, the brand's address.
ALTER TABLE gst_documents
  ADD COLUMN supplier_name     text CHECK (length(supplier_name) <= 120),
  ADD COLUMN supplier_gstin    text CHECK (supplier_gstin ~ '^([0-9A-Z]{15})?$'),
  ADD COLUMN supplier_address  text CHECK (length(supplier_address) <= 300),
  ADD COLUMN supplier_state    text CHECK (supplier_state ~ '^\d{2}$'),
  ADD COLUMN gst_bp            integer CHECK (gst_bp BETWEEN 0 AND 10000),
  ADD COLUMN recipient_address text CHECK (length(recipient_address) <= 500);
CREATE INDEX gst_documents_brand ON gst_documents (brand_id, issued_at);
