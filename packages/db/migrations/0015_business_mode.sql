-- The business switch (Prateek, 24 Oct 2026): POC or regular business, flipped by a super admin in
-- the admin portal; counts from the start of the business day it is made in. Append-only: every
-- switch kept with who, when and why.
CREATE TABLE business_modes (
  from_at    timestamptz PRIMARY KEY,
  mode       text        NOT NULL CHECK (mode IN ('poc', 'regular')),
  set_by     text        NOT NULL,
  reason     text        NOT NULL CHECK (length(reason) >= 5),
  set_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER business_modes_no_change BEFORE UPDATE OR DELETE ON business_modes
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER business_modes_no_truncate BEFORE TRUNCATE ON business_modes
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON business_modes TO recall_app;

-- A demo copy (Prateek, 25 Oct 2026: for showing investors, with made-up data). Only in such a
-- database can the super admin flip POC on and off freely. Only an empty database can be marked,
-- so the real system never can.
CREATE TABLE demo_copy (
  marked_at timestamptz PRIMARY KEY DEFAULT now(),
  marked_by text        NOT NULL
);
CREATE TRIGGER demo_copy_no_change BEFORE UPDATE OR DELETE ON demo_copy
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER demo_copy_no_truncate BEFORE TRUNCATE ON demo_copy
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON demo_copy TO recall_app;
