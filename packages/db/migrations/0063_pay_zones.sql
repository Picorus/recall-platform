-- P1.7.5 (Prateek, 28 Oct 2026): the rider pay zone depends on the business mode. One setting
-- each: 'pocZone' (the POC's circle: 15 km of Hitech City) and 'regularZone' (regular business:
-- inside any area that is on). The old 'payZone' rows stay as history (nothing is deleted); the
-- value in force is copied to the new setting it belongs to, as its version 1.
ALTER TABLE settings DROP CONSTRAINT settings_key_check;
ALTER TABLE settings ADD CONSTRAINT settings_key_check CHECK (key IN
  ('cities', 'fittingCentres', 'support', 'messages', 'payZone', 'pocZone', 'regularZone',
   'loanBank', 'riderSignIn', 'brandSignIn', 'freeWeek', 'company', 'poc'));

-- 'payZone' is history only from now on: no new versions.
CREATE FUNCTION settings_no_pay_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payZone is replaced by pocZone and regularZone (P1.7.5)';
END $$;
CREATE TRIGGER settings_no_pay_zone BEFORE INSERT ON settings
  FOR EACH ROW WHEN (NEW.key = 'payZone') EXECUTE FUNCTION settings_no_pay_zone();

-- A circle was the POC's zone; a list of areas was set for regular business. The newest of each
-- is copied.
INSERT INTO settings (key, version, value, saved_by, reason)
SELECT k.key, 1, p.value, 'migration',
       'P1.7.5: copied from the pay zone (v' || p.version || ') saved by ' || p.saved_by
  FROM (VALUES ('pocZone', true), ('regularZone', false)) k (key, circle)
  CROSS JOIN LATERAL (
    SELECT * FROM settings s
     WHERE s.key = 'payZone' AND (s.value ->> 'kind' = 'circle') = k.circle
     ORDER BY s.version DESC LIMIT 1) p;
