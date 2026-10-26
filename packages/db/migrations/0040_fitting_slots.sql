-- P3.11.3: fitting slots at the warehouse. Operations open slots (a centre, a start, how long, how
-- many bikes); an approved rider is booked into one (one at a time; a slot never takes more bikes
-- than it has room for); a booking can be cancelled with why. Nothing is edited or deleted: each
-- booking and cancellation is an event (hard rule 3). Fitting centres become a setting in P3.17.
CREATE TABLE fitting_slots (
  slot_id    text        PRIMARY KEY CHECK (slot_id ~ '^SLOT-[0-9A-F]{8}$'),
  centre     text        NOT NULL CHECK (length(centre) BETWEEN 2 AND 80),
  starts_at  timestamptz NOT NULL,
  minutes    integer     NOT NULL CHECK (minutes BETWEEN 15 AND 480),
  bikes      integer     NOT NULL CHECK (bikes BETWEEN 1 AND 100),
  created_by text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL
);
CREATE INDEX fitting_slots_start ON fitting_slots (starts_at);

CREATE TABLE fitting_bookings (
  rider_id text        NOT NULL REFERENCES riders (rider_id),
  seq      integer     NOT NULL CHECK (seq >= 1),
  slot_id  text        NOT NULL REFERENCES fitting_slots (slot_id),
  event    text        NOT NULL CHECK (event IN ('booked', 'cancelled')),
  reason   text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  by_who   text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at       timestamptz NOT NULL,
  PRIMARY KEY (rider_id, seq)
);
CREATE INDEX fitting_bookings_slot ON fitting_bookings (slot_id);

CREATE TRIGGER fitting_slots_no_change BEFORE UPDATE OR DELETE ON fitting_slots
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER fitting_slots_no_truncate BEFORE TRUNCATE ON fitting_slots
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER fitting_bookings_no_change BEFORE UPDATE OR DELETE ON fitting_bookings
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER fitting_bookings_no_truncate BEFORE TRUNCATE ON fitting_bookings
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON fitting_slots, fitting_bookings TO recall_app;
