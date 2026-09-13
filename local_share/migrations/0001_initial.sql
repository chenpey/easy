CREATE TABLE items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('text', 'file')),
  content TEXT,
  name TEXT,
  size INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting')),
  created_at INTEGER NOT NULL
);
CREATE INDEX items_state_seq ON items(state, seq);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  auth_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX login_attempts_time ON login_attempts(started_at);

CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  sweep_cursor TEXT NOT NULL DEFAULT ''
);
INSERT INTO app_state(id) VALUES (1);
