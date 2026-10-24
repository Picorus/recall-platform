-- P1.6: make-ups and refunds. A line short at its hour's end gets a make-up in the next 2 hours, then
-- the same hour the next day, then a refund for what is still missing. Each decision is made once and
-- kept (append-only, hard rule 3).

-- Make-ups owed to a booking line: an area, a window, and the plays owed.
CREATE TABLE make_ups (
  make_up_id   text        PRIMARY KEY,
  line_id      text        NOT NULL,
  booking_id   text        NOT NULL REFERENCES bookings (booking_id),
  area_id      text        NOT NULL,
  stage        smallint    NOT NULL CHECK (stage IN (1, 2)),
  day          date        NOT NULL,
  hours        integer[]   NOT NULL CHECK (cardinality(hours) BETWEEN 1 AND 4),
  window_from  timestamptz NOT NULL,
  window_until timestamptz NOT NULL CHECK (window_until > window_from),
  plays        integer     NOT NULL CHECK (plays > 0),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (make_up_id = line_id || '#' || stage)
);
CREATE INDEX make_ups_area_day ON make_ups (area_id, day);

-- Each decision for a line, once: after its hour ('first'), after the first make-up ('second'), and at
-- day close after the second ('refund').
CREATE TABLE line_settlements (
  line_id    text        NOT NULL,
  step       text        NOT NULL CHECK (step IN ('first', 'second', 'refund')),
  outcome    text        NOT NULL CHECK (outcome IN
               ('make-up', 'no window', 'not needed', 'refund', 'nothing paid')),
  owed       integer     NOT NULL CHECK (owed >= 0),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line_id, step)
);

-- Refunds proposed for missing plays (P1.6.4). A super admin approves or rejects each one (Prateek,
-- 22 Oct 2026); the credit note and the payment back come with the ledger (P1.7).
CREATE TABLE refunds (
  refund_id          text        PRIMARY KEY,
  line_id            text        NOT NULL UNIQUE,
  booking_id         text        NOT NULL REFERENCES bookings (booking_id),
  missing_plays      integer     NOT NULL CHECK (missing_plays > 0),
  promised_plays     integer     NOT NULL CHECK (promised_plays >= missing_plays),
  paid_paise         bigint      NOT NULL CHECK (paid_paise > 0),
  base_paise         bigint      NOT NULL CHECK (base_paise BETWEEN 0 AND paid_paise),
  gst_paise          bigint      NOT NULL CHECK (gst_paise >= 0),
  price_book_version integer     NOT NULL REFERENCES price_books (version),
  proposed_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (refund_id = line_id || '#refund')
);
CREATE TABLE refund_decisions (
  refund_id  text        PRIMARY KEY REFERENCES refunds (refund_id),
  decision   text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by text        NOT NULL,
  reason     text        NOT NULL CHECK (length(reason) >= 5),
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER make_ups_no_change BEFORE UPDATE OR DELETE ON make_ups
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER make_ups_no_truncate BEFORE TRUNCATE ON make_ups
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER line_settlements_no_change BEFORE UPDATE OR DELETE ON line_settlements
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER line_settlements_no_truncate BEFORE TRUNCATE ON line_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER refunds_no_change BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER refunds_no_truncate BEFORE TRUNCATE ON refunds
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER refund_decisions_no_change BEFORE UPDATE OR DELETE ON refund_decisions
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER refund_decisions_no_truncate BEFORE TRUNCATE ON refund_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON make_ups, line_settlements, refunds, refund_decisions TO recall_app;
