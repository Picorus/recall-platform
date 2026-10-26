-- P3.11.1: riders. Who a rider is (details as versions), each step he takes (applied → approved →
-- active, paused, left; or rejected) with who and why, the documents he sends and each review of
-- them, and staff notes. Nothing is edited or deleted (hard rule 3). Rider ids ("RD-000123") are
-- the ones screens' fittings, pay, payouts and loans already use.

CREATE SEQUENCE rider_numbers START 1;
GRANT USAGE ON SEQUENCE rider_numbers TO recall_app;

CREATE TABLE riders (
  rider_id   text        PRIMARY KEY CHECK (rider_id ~ '^RD-[0-9]{6}$'),
  channel    text        NOT NULL CHECK (channel IN ('app', 'admin')),
  created_by text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL
);

CREATE TABLE rider_versions (
  rider_id   text        NOT NULL REFERENCES riders (rider_id),
  version    integer     NOT NULL CHECK (version >= 1),
  name       text        NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  phone      text        NOT NULL CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  bike_plate text        CHECK (bike_plate ~ '^[A-Z0-9]{4,12}$'),
  rides      text        NOT NULL CHECK (length(rides) <= 120),
  apps       text[]      NOT NULL,
  reason     text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  set_by     text        NOT NULL CHECK (length(set_by) BETWEEN 1 AND 120),
  set_at     timestamptz NOT NULL,
  PRIMARY KEY (rider_id, version)
);
CREATE INDEX rider_versions_phone ON rider_versions (phone);
CREATE INDEX rider_versions_plate ON rider_versions (bike_plate);

CREATE TABLE rider_steps (
  rider_id text        NOT NULL REFERENCES riders (rider_id),
  seq      integer     NOT NULL CHECK (seq >= 1),
  status   text        NOT NULL CHECK (status IN
             ('applied', 'approved', 'rejected', 'active', 'paused', 'left')),
  reason   text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  by_who   text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at       timestamptz NOT NULL,
  PRIMARY KEY (rider_id, seq)
);

-- A document a rider sent: stored by fingerprint, read through short-lived signed links.
CREATE TABLE rider_documents (
  doc_id       text        PRIMARY KEY CHECK (doc_id ~ '^DOC-[0-9A-F]{10}$'),
  rider_id     text        NOT NULL REFERENCES riders (rider_id),
  kind         text        NOT NULL CHECK (kind IN ('photo', 'rc', 'insurance')),
  file_key     text        NOT NULL CHECK (file_key ~ '^[0-9a-f]{64}$'),
  file_type    text        NOT NULL CHECK (file_type IN ('png', 'jpeg', 'webp', 'pdf')),
  bytes        bigint      NOT NULL CHECK (bytes > 0),
  uploaded_by  text        NOT NULL CHECK (length(uploaded_by) BETWEEN 1 AND 120),
  uploaded_at  timestamptz NOT NULL,
  seq          bigint      GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX rider_documents_rider ON rider_documents (rider_id, kind, seq DESC);

-- One look at each document, final: accepted (insurance: with the last day it covers) or rejected
-- with why (the rider sends a new one).
CREATE TABLE rider_document_reviews (
  doc_id      text        PRIMARY KEY REFERENCES rider_documents (doc_id),
  decision    text        NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  reason      text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  expires_on  date,
  reviewed_by text        NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 120),
  reviewed_at timestamptz NOT NULL
);

-- Screens fitted to a rider (his page, his steps).
CREATE INDEX screen_fittings_rider ON screen_fittings (rider_id);

CREATE TABLE rider_notes (
  rider_id text        NOT NULL REFERENCES riders (rider_id),
  seq      integer     NOT NULL CHECK (seq >= 1),
  note     text        NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  by_who   text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at       timestamptz NOT NULL,
  PRIMARY KEY (rider_id, seq)
);

CREATE TRIGGER riders_no_change BEFORE UPDATE OR DELETE ON riders
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER riders_no_truncate BEFORE TRUNCATE ON riders
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_versions_no_change BEFORE UPDATE OR DELETE ON rider_versions
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_versions_no_truncate BEFORE TRUNCATE ON rider_versions
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_steps_no_change BEFORE UPDATE OR DELETE ON rider_steps
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_steps_no_truncate BEFORE TRUNCATE ON rider_steps
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_documents_no_change BEFORE UPDATE OR DELETE ON rider_documents
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_documents_no_truncate BEFORE TRUNCATE ON rider_documents
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_document_reviews_no_change BEFORE UPDATE OR DELETE ON rider_document_reviews
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_document_reviews_no_truncate BEFORE TRUNCATE ON rider_document_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_notes_no_change BEFORE UPDATE OR DELETE ON rider_notes
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_notes_no_truncate BEFORE TRUNCATE ON rider_notes
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON riders, rider_versions, rider_steps, rider_documents,
  rider_document_reviews, rider_notes TO recall_app;
