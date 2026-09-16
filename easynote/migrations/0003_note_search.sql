CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  content,
  content='notes',
  content_rowid='rowid',
  tokenize='trigram'
);

INSERT INTO notes_fts(notes_fts) VALUES('rebuild');

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
