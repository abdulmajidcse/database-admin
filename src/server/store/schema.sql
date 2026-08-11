-- App database (PLAN §5). One SQLite file under $DBADMIN_HOME.
-- Accessed synchronously on the main thread: it is tiny, unlike user databases
-- which run in worker threads (§6 "SQLite's four traps").

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- owner_id: connections are private to the user who created them (§9.2), and
-- their secrets are encrypted under that user's vault key, so another user
-- cannot read them even if a query forgets to filter.
CREATE TABLE IF NOT EXISTS connections (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT,
  name          TEXT NOT NULL,
  engine        TEXT NOT NULL,
  address_json  TEXT NOT NULL,   -- tcp | unix | file | uri  (§4)
  access_json   TEXT NOT NULL,   -- direct | ssh hop chain | process proxy  (§8)
  username      TEXT,
  secret_blob   BLOB,            -- AES-256-GCM ciphertext; NULL for SQLite / agent auth
  secret_nonce  BLOB,
  ssh_secrets   BLOB,            -- encrypted JSON array of hop passphrases
  ssh_nonce     BLOB,
  tls_json      TEXT,
  options_json  TEXT NOT NULL DEFAULT '{}',
  read_only     INTEGER NOT NULL DEFAULT 0,
  color         TEXT,
  env_tag       TEXT NOT NULL DEFAULT 'dev',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS query_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      TEXT,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  sql           TEXT NOT NULL,
  db_context    TEXT,
  started_at    INTEGER NOT NULL,
  duration_ms   INTEGER,
  row_count     INTEGER,
  status        TEXT NOT NULL,          -- ok | error | cancelled
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_conn ON query_history(connection_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_time ON query_history(started_at DESC);

CREATE TABLE IF NOT EXISTS saved_queries (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT,
  name          TEXT NOT NULL,
  folder        TEXT NOT NULL DEFAULT '',
  sql           TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  params_json   TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_folder ON saved_queries(folder, name);

CREATE TABLE IF NOT EXISTS schema_cache (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  model_json    TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL,
  PRIMARY KEY (connection_id, scope)
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,          -- export | import | restore | copy
  connection_id TEXT,
  title         TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  status        TEXT NOT NULL,          -- queued | running | cancelling | done | failed | cancelled
  progress_json TEXT NOT NULL DEFAULT '{}',
  log_tail      TEXT NOT NULL DEFAULT '',
  result_json   TEXT,
  error         TEXT,
  started_at    INTEGER,
  ended_at      INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS transfer_presets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace (
  id            TEXT PRIMARY KEY,
  json          TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
