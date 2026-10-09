import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The index and transcript bodies share this schema and one database file. */
export const transaction = <T>(db: DatabaseSync, write: () => T): T => {
  db.exec('BEGIN IMMEDIATE')
  try { const result = write(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}

export function openSessionDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > 3) throw new Error('Session index is from a newer schema')
    if (version === 0) transaction(db, () => {
      db.exec(`CREATE TABLE sessions (
        runtime TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('desk','imported')),
        title TEXT, preview TEXT, cwd TEXT NOT NULL, repo_root TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, removed_at REAL, team_id TEXT,
        status TEXT NOT NULL DEFAULT '{"type":"notLoaded"}', git TEXT, PRIMARY KEY(runtime,id)
      );
      CREATE INDEX sessions_sidebar ON sessions(origin,removed_at,team_id,updated_at DESC);
      CREATE INDEX sessions_page ON sessions(origin,removed_at,team_id,archived,updated_at DESC,runtime,id);
      CREATE INDEX sessions_repo ON sessions(repo_root,updated_at DESC);
      CREATE INDEX sessions_cwd ON sessions(cwd);
      CREATE TABLE repos (cwd TEXT PRIMARY KEY, repo_root TEXT, origin_url TEXT, worktree INTEGER NOT NULL DEFAULT 0,
        "exists" INTEGER NOT NULL, checked_at REAL NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;`)
    })
    if (version < 2) transaction(db, () => {
      // v1 stored archive as NOT NULL; preserve all rows, including tombstones.
      db.exec(`ALTER TABLE sessions RENAME TO sessions_v1;
        DROP INDEX sessions_sidebar; DROP INDEX sessions_page; DROP INDEX sessions_repo; DROP INDEX sessions_cwd;
        CREATE TABLE sessions (
          runtime TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('desk','imported')),
          title TEXT, preview TEXT, cwd TEXT NOT NULL, repo_root TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
          archived INTEGER DEFAULT 0, removed_at REAL, team_id TEXT,
          status TEXT NOT NULL DEFAULT '{"type":"notLoaded"}', git TEXT, PRIMARY KEY(runtime,id)
        );
        INSERT INTO sessions SELECT * FROM sessions_v1;
        DROP TABLE sessions_v1;
        CREATE INDEX sessions_sidebar ON sessions(origin,removed_at,team_id,updated_at DESC);
        CREATE INDEX sessions_page ON sessions(origin,removed_at,team_id,archived,updated_at DESC,runtime,id);
        CREATE INDEX sessions_repo ON sessions(repo_root,updated_at DESC);
        CREATE INDEX sessions_cwd ON sessions(cwd);
        ALTER TABLE repos ADD COLUMN identity TEXT;
        PRAGMA user_version = 2;`)
    })
    if (version < 3) transaction(db, () => {
      db.exec(`ALTER TABLE sessions ADD COLUMN body TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE sessions ADD COLUMN saved_at REAL;
        ALTER TABLE sessions ADD COLUMN usage TEXT;
        CREATE TABLE bodies(runtime TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(runtime,id));
        CREATE TABLE turns(runtime TEXT NOT NULL, id TEXT NOT NULL, turn_id TEXT NOT NULL, seq INTEGER NOT NULL,
          payload TEXT NOT NULL, insight TEXT, fingerprint TEXT NOT NULL, PRIMARY KEY(runtime,id,turn_id));
        CREATE TABLE items(runtime TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT NOT NULL,
          item_id TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT, text TEXT NOT NULL,
          message_text TEXT NOT NULL, tool_text TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(runtime,id,seq));
        CREATE INDEX items_occurrence ON items(runtime,id,turn_id,item_id,seq);
        CREATE VIRTUAL TABLE items_fts USING fts5(message_text,tool_text,content='items',content_rowid='rowid',tokenize='trigram');
        CREATE TRIGGER items_insert AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid,message_text,tool_text) VALUES(new.rowid,new.message_text,new.tool_text); END;
        CREATE TRIGGER items_delete AFTER DELETE ON items BEGIN
          INSERT INTO items_fts(items_fts,rowid,message_text,tool_text) VALUES('delete',old.rowid,old.message_text,old.tool_text); END;
        CREATE TRIGGER items_update AFTER UPDATE ON items BEGIN
          INSERT INTO items_fts(items_fts,rowid,message_text,tool_text) VALUES('delete',old.rowid,old.message_text,old.tool_text);
          INSERT INTO items_fts(rowid,message_text,tool_text) VALUES(new.rowid,new.message_text,new.tool_text); END;
        PRAGMA user_version = 3;`)
    })
    return db
  } catch (error) { db.close(); throw error }
}
