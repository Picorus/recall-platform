-- P1.9: final campaign reports, kept exactly as built; brands' contacts for sending them (latest
-- wins); and every try to send a report on WhatsApp or email. Append-only (hard rule 3).
CREATE TABLE campaign_reports (
  booking_id text        PRIMARY KEY REFERENCES bookings (booking_id),
  built_at   timestamptz NOT NULL,
  report     jsonb       NOT NULL
);

CREATE TABLE brand_contacts (
  brand_id text        NOT NULL CHECK (length(brand_id) BETWEEN 1 AND 64),
  set_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- India mobile numbers in full (+91 and 10 digits); email in a plain shape.
  phone    text        CHECK (phone ~ '^\+91[6-9]\d{9}$'),
  email    text        CHECK (email ~ '^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$'),
  set_by   text        NOT NULL,
  PRIMARY KEY (brand_id, set_at),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE report_sends (
  booking_id text        NOT NULL REFERENCES campaign_reports (booking_id),
  channel    text        NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  try        integer     NOT NULL CHECK (try >= 1),
  sent_to    text        NOT NULL,
  status     text        NOT NULL CHECK (status IN ('sent', 'failed')),
  detail     text        NOT NULL DEFAULT '',
  at         timestamptz NOT NULL,
  PRIMARY KEY (booking_id, channel, try)
);

CREATE TRIGGER campaign_reports_no_change BEFORE UPDATE OR DELETE ON campaign_reports
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER campaign_reports_no_truncate BEFORE TRUNCATE ON campaign_reports
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_contacts_no_change BEFORE UPDATE OR DELETE ON brand_contacts
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_contacts_no_truncate BEFORE TRUNCATE ON brand_contacts
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER report_sends_no_change BEFORE UPDATE OR DELETE ON report_sends
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER report_sends_no_truncate BEFORE TRUNCATE ON report_sends
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON campaign_reports, brand_contacts, report_sends TO recall_app;
