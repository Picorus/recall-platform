-- P5.11: the brand's few messages about a campaign, besides its report (report_sends): "booked and
-- paid", and a reminder 9 and 7 days before the start while no ads are chosen. Each kind, channel
-- and try is kept once (sent with the same key every try, so never twice). Append-only (rule 3).
CREATE TABLE brand_notices (
  booking_id text        NOT NULL REFERENCES bookings (booking_id),
  kind       text        NOT NULL CHECK (kind IN ('paid', 'ads-9', 'ads-7')),
  channel    text        NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  try        integer     NOT NULL CHECK (try >= 1),
  sent_to    text        NOT NULL,
  status     text        NOT NULL CHECK (status IN ('sent', 'failed')),
  retryable  boolean     NOT NULL DEFAULT false,
  detail     text        NOT NULL DEFAULT '',
  at         timestamptz NOT NULL,
  PRIMARY KEY (booking_id, kind, channel, try)
);

CREATE TRIGGER brand_notices_no_change BEFORE UPDATE OR DELETE ON brand_notices
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_notices_no_truncate BEFORE TRUNCATE ON brand_notices
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON brand_notices TO recall_app;
