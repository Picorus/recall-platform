-- P2.13: our own update system for the screen player. Each release is the new build and its
-- rollback build (the last good code numbered above it: Android never installs an older version).
-- A rollout's life is its events (started, advanced, finished, rolled back, replaced): append-only.
-- Health reports now carry the player's version code and the box's crash count, which judge it.
ALTER TABLE screen_health ADD COLUMN app_code integer CHECK (app_code >= 1);
ALTER TABLE screen_health ADD COLUMN crashes bigint CHECK (crashes >= 0);
CREATE INDEX screen_health_app_code ON screen_health (app_code, t);

CREATE TABLE player_releases (
  id               text        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{3,40}$'),
  version_code     integer     NOT NULL UNIQUE CHECK (version_code >= 1),
  version_name     text        NOT NULL CHECK (version_name ~ '^[0-9A-Za-z.+-]{1,40}$'),
  sha256           text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes            integer     NOT NULL CHECK (bytes > 0),
  url              text        NOT NULL CHECK (url LIKE 'https://%'),
  rb_version_code  integer     NOT NULL UNIQUE CHECK (rb_version_code > version_code),
  rb_version_name  text        NOT NULL CHECK (rb_version_name ~ '^[0-9A-Za-z.+-]{1,40}$'),
  rb_sha256        text        NOT NULL CHECK (rb_sha256 ~ '^[0-9a-f]{64}$'),
  rb_bytes         integer     NOT NULL CHECK (rb_bytes > 0),
  rb_url           text        NOT NULL CHECK (rb_url LIKE 'https://%'),
  made_at          timestamptz NOT NULL,
  by               text        NOT NULL CHECK (length(by) BETWEEN 1 AND 80),
  notes            text        NOT NULL CHECK (length(notes) <= 2000)
);

CREATE TABLE release_events (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id text        NOT NULL REFERENCES player_releases (id),
  kind       text        NOT NULL CHECK (kind IN ('started', 'advanced', 'finished', 'rolled-back', 'replaced')),
  stage      smallint    NOT NULL CHECK (stage >= 0),
  at         timestamptz NOT NULL,
  why        text        NOT NULL CHECK (length(why) <= 300),
  by         text        NOT NULL CHECK (length(by) BETWEEN 1 AND 80)
);
CREATE INDEX release_events_latest ON release_events (release_id, id DESC);

CREATE TRIGGER player_releases_no_change BEFORE UPDATE OR DELETE ON player_releases
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER player_releases_no_truncate BEFORE TRUNCATE ON player_releases
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER release_events_no_change BEFORE UPDATE OR DELETE ON release_events
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER release_events_no_truncate BEFORE TRUNCATE ON release_events
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON player_releases, release_events TO recall_app;
