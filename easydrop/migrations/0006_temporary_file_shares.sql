CREATE TABLE file_shares (
  token_hash TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX file_shares_expires_at ON file_shares(expires_at);
