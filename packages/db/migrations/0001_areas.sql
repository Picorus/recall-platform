-- P1.1 Areas. Every change is a new row; rows are never edited or deleted (hard rule 3).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE FUNCTION recall_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TABLE area_versions (
  area_id    text        NOT NULL CHECK (area_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  version    integer     NOT NULL CHECK (version >= 1),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  city       text        NOT NULL CHECK (length(city) BETWEEN 1 AND 80),
  shape      geography(Polygon, 4326) NOT NULL CHECK (ST_IsValid(shape::geometry)),
  edge_m     integer     NOT NULL CHECK (edge_m BETWEEN 0 AND 2000),
  valid_from timestamptz NOT NULL,
  draft      boolean     NOT NULL,
  active     boolean     NOT NULL,
  -- Who saved it (staff id or "system"), for the audit log.
  saved_by   text        NOT NULL CHECK (length(saved_by) BETWEEN 1 AND 120),
  saved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (area_id, version)
);

CREATE INDEX area_versions_shape ON area_versions USING gist (shape);

CREATE TRIGGER area_versions_no_change BEFORE UPDATE OR DELETE ON area_versions
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER area_versions_no_truncate BEFORE TRUNCATE ON area_versions
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

-- A new version must be exactly the next number and start after the one it replaces (P1.1.2).
CREATE FUNCTION area_versions_next() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_version integer;
  last_from timestamptz;
BEGIN
  SELECT version, valid_from INTO last_version, last_from
    FROM area_versions WHERE area_id = NEW.area_id ORDER BY version DESC LIMIT 1;
  IF last_version IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'area %: the first version must be 1, not %', NEW.area_id, NEW.version;
    END IF;
  ELSIF NEW.version <> last_version + 1 THEN
    RAISE EXCEPTION 'area %: next version must be %, not %', NEW.area_id, last_version + 1, NEW.version;
  ELSIF NEW.valid_from <= last_from THEN
    RAISE EXCEPTION 'area %: version % must start after %', NEW.area_id, NEW.version, last_from;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER area_versions_next BEFORE INSERT ON area_versions
  FOR EACH ROW EXECUTE FUNCTION area_versions_next();
