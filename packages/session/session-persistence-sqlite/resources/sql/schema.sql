CREATE TABLE persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id  TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY,
  session_key      TEXT NOT NULL UNIQUE,
  version          INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  cwd              TEXT,
  parent_session   TEXT,
  seed_length      INTEGER,
  origin           TEXT,
  delegation_depth INTEGER,
  agent_preset     TEXT,
  application_id   TEXT,
  tenant_id        TEXT,
  user_id          TEXT,
  incarnation      TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  CHECK ((application_id IS NULL AND tenant_id IS NULL AND user_id IS NULL)
      OR (length(application_id) > 0 AND length(tenant_id) > 0 AND length(user_id) > 0))
) STRICT;

CREATE TABLE events (
  session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  time              INTEGER NOT NULL,
  data              ANY NOT NULL,
  source_event_seqs ANY,
  surface_op        TEXT,
  ignorable         INTEGER CHECK (ignorable IS NULL OR ignorable IN (0, 1)),
  PRIMARY KEY (session_id, seq)
) STRICT;
