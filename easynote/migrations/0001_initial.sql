PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_verifier TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  recovery_code_hash TEXT,
  recovery_code_created_at INTEGER,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deletion_requested_at INTEGER
);
CREATE INDEX users_state ON users(enabled, deletion_requested_at, role);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE integration_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  access TEXT NOT NULL CHECK(access IN ('read', 'read-write')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX integration_tokens_user ON integration_tokens(user_id, revoked_at, expires_at);
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE TABLE account_attempts (
  key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX account_attempts_time ON account_attempts(started_at);
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  self_registration_enabled INTEGER NOT NULL DEFAULT 0
    CHECK(self_registration_enabled IN (0, 1))
);
INSERT INTO app_state(id) VALUES(1);
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  dedup_hash TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT NOT NULL,
  mutation_hash TEXT NOT NULL
);
CREATE INDEX notes_list ON notes(user_id, deleted_at, archived, pinned DESC, updated_at DESC, id);
CREATE INDEX notes_dedup ON notes(user_id, dedup_hash);
CREATE UNIQUE INDEX notes_one_blank ON notes(user_id)
  WHERE title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL;
CREATE TABLE note_versions (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  deleted_at INTEGER,
  saved_at INTEGER NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK(actor_type IN ('user', 'ai')),
  actor_name TEXT NOT NULL DEFAULT 'User',
  PRIMARY KEY(note_id, revision)
);
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'deleting')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX images_user ON images(user_id, status);
CREATE TABLE image_refs (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  PRIMARY KEY(note_id, image_id, revision)
);
CREATE INDEX image_refs_image ON image_refs(image_id);
CREATE TABLE purged_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purged_at INTEGER NOT NULL
);
CREATE TABLE note_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX note_changes_sync ON note_changes(user_id, sequence);
CREATE INDEX note_changes_note ON note_changes(user_id, note_id, sequence);
CREATE TABLE note_shares (
  token_hash TEXT PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX note_shares_expiry ON note_shares(expires_at);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  content,
  content='notes',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid,title,content)
  VALUES(new.rowid,new.title,new.content);
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,title,content)
  VALUES('delete',old.rowid,old.title,old.content);
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE OF title,content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,title,content)
  VALUES('delete',old.rowid,old.title,old.content);
  INSERT INTO notes_fts(rowid,title,content)
  VALUES(new.rowid,new.title,new.content);
END;
