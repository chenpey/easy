CREATE TABLE operations (
  request_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX operations_created_at ON operations(created_at);
CREATE INDEX items_pending_age ON items(state, created_at);
