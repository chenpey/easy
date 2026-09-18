CREATE TABLE note_shares_v2 (
  token_hash TEXT PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO note_shares_v2(token_hash,note_id,expires_at,created_at)
SELECT token_hash,note_id,expires_at,created_at FROM note_shares;

DROP TABLE note_shares;
ALTER TABLE note_shares_v2 RENAME TO note_shares;
CREATE INDEX note_shares_expiry ON note_shares(expires_at);
