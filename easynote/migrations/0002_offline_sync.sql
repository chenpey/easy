PRAGMA foreign_keys = ON;

CREATE TABLE note_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX note_changes_sync ON note_changes(user_id, sequence);
CREATE INDEX note_changes_note ON note_changes(user_id, note_id, sequence);

INSERT INTO note_changes(user_id, note_id, changed_at)
SELECT user_id, id, updated_at FROM notes ORDER BY updated_at, id;
