-- P1.7.5 review (S3): when the rider pay zone was split by business mode (0063). Minutes before it
-- keep the result they had then (the seconds the screen marked inside its POC circle, whatever the
-- old single zone said: the screens never got that setting); the new pocZone and regularZone apply
-- from it.
CREATE TABLE pay_zone_split (
  at timestamptz NOT NULL
);
INSERT INTO pay_zone_split (at)
SELECT coalesce((SELECT applied_at FROM schema_migrations WHERE name = '0063_pay_zones.sql'), now());
CREATE TRIGGER pay_zone_split_no_change BEFORE UPDATE OR DELETE ON pay_zone_split
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER pay_zone_split_no_truncate BEFORE TRUNCATE ON pay_zone_split
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT ON pay_zone_split TO recall_app;
