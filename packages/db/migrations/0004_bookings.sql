-- P1.3 Inventory, prices and bookings. Price books are versioned settings; a booking keeps the
-- version it was sold on. A booking's step is never edited: each move is a new event row, and the
-- current step is the latest event. Holds end at their time and are never deleted. Append-only.

CREATE TABLE price_books (
  version    integer     PRIMARY KEY CHECK (version >= 1),
  valid_from timestamptz NOT NULL,
  book       jsonb       NOT NULL,
  saved_by   text        NOT NULL,
  saved_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER price_books_no_change BEFORE UPDATE OR DELETE ON price_books
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER price_books_no_truncate BEFORE TRUNCATE ON price_books
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE FUNCTION price_books_next() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_version integer;
  last_from timestamptz;
BEGIN
  SELECT version, valid_from INTO last_version, last_from FROM price_books ORDER BY version DESC LIMIT 1;
  IF NEW.version <> coalesce(last_version, 0) + 1 THEN
    RAISE EXCEPTION 'price book: next version must be %, not %', coalesce(last_version, 0) + 1, NEW.version;
  END IF;
  IF last_from IS NOT NULL AND NEW.valid_from <= last_from THEN
    RAISE EXCEPTION 'price book: version % must start after %', NEW.version, last_from;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER price_books_next BEFORE INSERT ON price_books FOR EACH ROW EXECUTE FUNCTION price_books_next();

-- Sales holds (no money; end at `until`).
CREATE TABLE holds (
  hold_id    text        PRIMARY KEY CHECK (hold_id ~ '^[A-Za-z0-9-]{4,40}$'),
  brand_id   text        NOT NULL,
  until      timestamptz NOT NULL,
  held_by    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bookings (
  booking_id         text        PRIMARY KEY CHECK (booking_id ~ '^[A-Za-z0-9-]{4,40}$'),
  brand_id           text        NOT NULL CHECK (length(brand_id) BETWEEN 1 AND 64),
  channel            text        NOT NULL CHECK (channel IN ('portal', 'admin')),
  trial              boolean     NOT NULL,
  repeat_months      integer     NOT NULL CHECK (repeat_months >= 1),
  -- The sales hold this booking turns into, if any (its bikes are not counted against it).
  hold_id            text REFERENCES holds (hold_id),
  price_book_version integer     NOT NULL REFERENCES price_books (version),
  subtotal_paise     bigint      NOT NULL CHECK (subtotal_paise >= 0),
  gst_paise          bigint      NOT NULL CHECK (gst_paise >= 0),
  total_paise        bigint      NOT NULL CHECK (total_paise = subtotal_paise + gst_paise),
  first_hour_at      timestamptz NOT NULL,
  last_hour_ends_at  timestamptz NOT NULL CHECK (last_hour_ends_at > first_hour_at),
  ads_due_at         timestamptz NOT NULL CHECK (ads_due_at <= first_hour_at),
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE booking_lines (
  booking_id           text    NOT NULL REFERENCES bookings (booking_id),
  area_id              text    NOT NULL,
  area_version         integer NOT NULL,
  day                  date    NOT NULL,
  start_hour           integer NOT NULL CHECK (start_hour BETWEEN 8 AND 25),
  bikes                integer NOT NULL CHECK (bikes >= 1),
  paise_per_bike_hour  bigint  NOT NULL CHECK (paise_per_bike_hour >= 0),
  plays                integer NOT NULL CHECK (plays >= 0),
  paise                bigint  NOT NULL CHECK (paise = bikes * paise_per_bike_hour),
  PRIMARY KEY (booking_id, area_id, day, start_hour),
  FOREIGN KEY (area_id, area_version) REFERENCES area_versions (area_id, version)
);
CREATE INDEX booking_lines_area_hour ON booking_lines (area_id, day, start_hour);

-- Steps: draft → awaiting-payment → paid → ads-approved → running → done → report-sent, or
-- cancelled / ads-missing. The rules for each move live in @recall/domain (booking-flow.ts).
CREATE TABLE booking_events (
  booking_id text        NOT NULL REFERENCES bookings (booking_id),
  seq        integer     NOT NULL CHECK (seq >= 1),
  state      text        NOT NULL CHECK (state IN ('draft', 'awaiting-payment', 'paid', 'ads-approved',
                           'running', 'done', 'report-sent', 'cancelled', 'ads-missing')),
  at         timestamptz NOT NULL DEFAULT now(),
  by_who     text        NOT NULL,
  reason     text,
  PRIMARY KEY (booking_id, seq)
);

CREATE TABLE trials_used (
  identity   text PRIMARY KEY CHECK (identity ~ '^(phone|gstin):'),
  booking_id text NOT NULL REFERENCES bookings (booking_id)
);

-- Lines of sales holds, and manual limits a super admin sets on area-hours.
CREATE TABLE hold_lines (
  hold_id    text    NOT NULL REFERENCES holds (hold_id),
  area_id    text    NOT NULL,
  day        date    NOT NULL,
  start_hour integer NOT NULL CHECK (start_hour BETWEEN 8 AND 25),
  bikes      integer NOT NULL CHECK (bikes >= 1),
  PRIMARY KEY (hold_id, area_id, day, start_hour)
);
CREATE TABLE area_hour_limits (
  area_id    text        NOT NULL,
  day        date        NOT NULL,
  start_hour integer     NOT NULL CHECK (start_hour BETWEEN 8 AND 25),
  version    integer     NOT NULL CHECK (version >= 1),
  -- NULL lifts the limit again.
  max_bikes  integer     CHECK (max_bikes >= 0),
  set_by     text        NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (area_id, day, start_hour, version)
);

CREATE TRIGGER bookings_no_change BEFORE UPDATE OR DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER bookings_no_truncate BEFORE TRUNCATE ON bookings
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE TRIGGER booking_lines_no_change BEFORE UPDATE OR DELETE ON booking_lines
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER booking_lines_no_truncate BEFORE TRUNCATE ON booking_lines
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE TRIGGER booking_events_no_change BEFORE UPDATE OR DELETE ON booking_events
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER booking_events_no_truncate BEFORE TRUNCATE ON booking_events
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE TRIGGER trials_used_no_change BEFORE UPDATE OR DELETE ON trials_used
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER trials_used_no_truncate BEFORE TRUNCATE ON trials_used
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE TRIGGER holds_no_change BEFORE UPDATE OR DELETE ON holds
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER holds_no_truncate BEFORE TRUNCATE ON holds
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE TRIGGER hold_lines_no_change BEFORE UPDATE OR DELETE ON hold_lines
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER hold_lines_no_truncate BEFORE TRUNCATE ON hold_lines
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE TRIGGER area_hour_limits_no_change BEFORE UPDATE OR DELETE ON area_hour_limits
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER area_hour_limits_no_truncate BEFORE TRUNCATE ON area_hour_limits
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON price_books, bookings, booking_lines, booking_events, trials_used, holds,
  hold_lines, area_hour_limits TO recall_app;
