CREATE TABLE multipart_uploads (
  item_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  chunk_size INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'completing')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX multipart_uploads_updated_at ON multipart_uploads(updated_at);

CREATE TABLE multipart_parts (
  item_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, part_number)
);
