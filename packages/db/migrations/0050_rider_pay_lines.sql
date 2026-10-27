-- P4.5: what each rider-pay posting was made of. The ledger keeps only the amounts (earnings, TDS,
-- payable); the rider app's Earnings page shows him the parts: moving hours, the POC base, ₹25 an
-- hour and his share of sales. Each time the pay run posts a change for a rider and month, the
-- month's parts as they stand then are kept beside that entry. Append-only (hard rule 3).
CREATE TABLE rider_pay_lines (
  entry_id      text        PRIMARY KEY REFERENCES ledger_entries (entry_id),
  rider_id      text        NOT NULL CHECK (rider_id ~ '^[A-Za-z0-9-]{3,40}$'),
  month         text        NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  at            timestamptz NOT NULL,
  counted_s     bigint      NOT NULL CHECK (counted_s >= 0),
  paid_s        bigint      NOT NULL CHECK (paid_s >= 0 AND paid_s <= counted_s),
  poc_paise     bigint      NOT NULL CHECK (poc_paise >= 0),
  hourly_paise  bigint      NOT NULL CHECK (hourly_paise >= 0),
  sold_paise    bigint      NOT NULL CHECK (sold_paise >= 0),
  gross_paise   bigint      NOT NULL CHECK (gross_paise = poc_paise + hourly_paise + sold_paise),
  tds_paise     bigint      NOT NULL CHECK (tds_paise >= 0 AND tds_paise <= gross_paise)
);
CREATE INDEX rider_pay_lines_rider ON rider_pay_lines (rider_id, month, at DESC);
CREATE TRIGGER rider_pay_lines_no_change BEFORE UPDATE OR DELETE ON rider_pay_lines
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_pay_lines_no_truncate BEFORE TRUNCATE ON rider_pay_lines
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_pay_lines TO recall_app;
