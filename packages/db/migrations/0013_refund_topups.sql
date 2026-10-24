-- A refund topped up at approval (P1.7.4): more plays were missing than when it was proposed (a stolen
-- screen found meanwhile). Recorded once, with who and what, so the refund records match the ledger.
CREATE TABLE refund_topups (
  refund_id     text        PRIMARY KEY REFERENCES refunds (refund_id),
  booking_id    text        NOT NULL REFERENCES bookings (booking_id),
  missing_plays integer     NOT NULL CHECK (missing_plays > 0),
  base_paise    bigint      NOT NULL CHECK (base_paise > 0),
  gst_paise     bigint      NOT NULL CHECK (gst_paise >= 0),
  decided_by    text        NOT NULL,
  decided_at    timestamptz NOT NULL
);
CREATE TRIGGER refund_topups_no_change BEFORE UPDATE OR DELETE ON refund_topups
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER refund_topups_no_truncate BEFORE TRUNCATE ON refund_topups
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON refund_topups TO recall_app;
