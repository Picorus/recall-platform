-- P3.8.2: booking for a brand. Each payment link sent for a booking (one per booking and amount;
-- the provider gives the same link for the same key), what happened to it (paid, expired, cancelled,
-- or paid after the booking was cancelled: money that arrives is always recorded), and staff notes
-- on a booking. Append-only (hard rule 3).
CREATE TABLE payment_links (
  -- The same shape the provider's messages are checked against, so every stored link can be paid.
  link_id      text        PRIMARY KEY CHECK (link_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  booking_id   text        NOT NULL REFERENCES bookings (booking_id),
  amount_paise bigint      NOT NULL CHECK (amount_paise > 0),
  url          text        NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 500),
  expires_at   timestamptz NOT NULL,
  created_by   text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
  created_at   timestamptz NOT NULL
);
CREATE INDEX payment_links_booking ON payment_links (booking_id, created_at DESC);

-- What happened to each link. A link runs out or is stopped once; each payment (by the provider's
-- id) is recorded once, whatever arrives again. 'paid-late': paid after the booking was cancelled;
-- 'wrong-amount': not the link's amount. Both are owed back (a ledger entry, for finance).
CREATE TABLE payment_link_events (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id    text        NOT NULL REFERENCES payment_links (link_id),
  state      text        NOT NULL CHECK (state IN ('paid', 'expired', 'cancelled', 'paid-late', 'wrong-amount')),
  payment_id text        CHECK (payment_id IS NULL OR payment_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  amount_paise bigint    CHECK (amount_paise IS NULL OR amount_paise >= 0),
  at         timestamptz NOT NULL,
  CHECK ((state IN ('expired', 'cancelled')) = (payment_id IS NULL))
);
CREATE UNIQUE INDEX payment_link_events_once ON payment_link_events (link_id, state)
  WHERE state IN ('expired', 'cancelled');
CREATE UNIQUE INDEX payment_link_events_payment ON payment_link_events (payment_id)
  WHERE payment_id IS NOT NULL;
CREATE INDEX payment_link_events_link ON payment_link_events (link_id, id);

-- Signed messages from the provider about a link we have no record of: kept for finance, never
-- dropped (money may be behind them).
CREATE TABLE payment_inbox (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id     text        NOT NULL,
  payment_id  text        UNIQUE,
  event       jsonb       NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE booking_notes (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id text        NOT NULL REFERENCES bookings (booking_id),
  note       text        NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  by         text        NOT NULL CHECK (length(by) BETWEEN 1 AND 120),
  at         timestamptz NOT NULL
);
CREATE INDEX booking_notes_booking ON booking_notes (booking_id, id);

CREATE TRIGGER payment_links_no_change BEFORE UPDATE OR DELETE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payment_links_no_truncate BEFORE TRUNCATE ON payment_links
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payment_link_events_no_change BEFORE UPDATE OR DELETE ON payment_link_events
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payment_link_events_no_truncate BEFORE TRUNCATE ON payment_link_events
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payment_inbox_no_change BEFORE UPDATE OR DELETE ON payment_inbox
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payment_inbox_no_truncate BEFORE TRUNCATE ON payment_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER booking_notes_no_change BEFORE UPDATE OR DELETE ON booking_notes
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER booking_notes_no_truncate BEFORE TRUNCATE ON booking_notes
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON payment_links, payment_link_events, payment_inbox, booking_notes TO recall_app;
