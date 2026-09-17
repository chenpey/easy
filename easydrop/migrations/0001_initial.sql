PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_verifier TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  auth_version INTEGER NOT NULL DEFAULT 1,
  recovery_code_hash TEXT,
  recovery_code_created_at INTEGER,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deletion_requested_at INTEGER,
  content_revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX users_enabled ON users(enabled);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user_id ON sessions(user_id);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX login_attempts_time ON login_attempts(started_at);

CREATE TABLE account_attempts (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX account_attempts_time ON account_attempts(started_at);

CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  sweep_cursor TEXT NOT NULL DEFAULT '',
  self_registration_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (self_registration_enabled IN (0, 1))
);
INSERT INTO app_state(id) VALUES (1);

CREATE TABLE items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'file')),
  content TEXT,
  name TEXT,
  size INTEGER,
  media_type TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX items_owner_state_seq ON items(owner_user_id, state, seq);
CREATE INDEX items_pending_age ON items(state, created_at);

CREATE TABLE operations (
  user_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX operations_created_at ON operations(created_at);

CREATE TABLE multipart_uploads (
  item_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'completing')),
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, operation_key),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX multipart_uploads_updated_at ON multipart_uploads(updated_at);

CREATE TABLE multipart_parts (
  item_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, part_number),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE file_shares (
  token_hash TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX file_shares_expires_at ON file_shares(expires_at);
