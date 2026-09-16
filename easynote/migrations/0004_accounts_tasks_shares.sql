PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK(role IN ('admin', 'user'));
ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1
  CHECK(enabled IN (0, 1));
ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;
ALTER TABLE users ADD COLUMN recovery_code_created_at INTEGER;
ALTER TABLE users ADD COLUMN approved_at INTEGER;
ALTER TABLE users ADD COLUMN updated_at INTEGER;
ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER;

UPDATE users SET
  role=CASE WHEN id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1) THEN 'admin' ELSE role END,
  approved_at=created_at,
  updated_at=created_at;

CREATE INDEX users_state ON users(enabled, deletion_requested_at, role);

CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  self_registration_enabled INTEGER NOT NULL DEFAULT 0
    CHECK(self_registration_enabled IN (0, 1))
);
INSERT INTO app_state(id) VALUES(1);

CREATE TABLE account_attempts (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX account_attempts_time ON account_attempts(started_at);

CREATE TABLE note_shares (
  token_hash TEXT PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX note_shares_expiry ON note_shares(expires_at);
