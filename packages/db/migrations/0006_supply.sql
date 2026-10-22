-- P1.3.7 (Prateek, 22 Oct 2026): starting estimates of how many bikes an area-hour can carry, set by a
-- super admin, used until the screens have shown enough weeks of real numbers. Versioned, append-only.
CREATE TABLE area_supply_estimates (
  area_id    text        NOT NULL,
  start_hour integer     NOT NULL CHECK (start_hour BETWEEN 8 AND 25),
  version    integer     NOT NULL CHECK (version >= 1),
  bikes      integer     NOT NULL CHECK (bikes >= 0),
  set_by     text        NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (area_id, start_hour, version)
);
CREATE TRIGGER area_supply_estimates_no_change BEFORE UPDATE OR DELETE ON area_supply_estimates
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER area_supply_estimates_no_truncate BEFORE TRUNCATE ON area_supply_estimates
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON area_supply_estimates TO recall_app;

-- Finding last weeks' minutes for an area-hour quickly.
CREATE INDEX minute_summaries_minute ON minute_summaries (minute);
