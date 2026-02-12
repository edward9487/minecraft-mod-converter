import Database from "better-sqlite3";
import path from "path";
import os from "os";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(os.tmpdir(), "modlist-share-codes.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // 初始化表
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_codes (
      id TEXT PRIMARY KEY,
      targetVersion TEXT NOT NULL,
      loader TEXT NOT NULL,
      items TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      savedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_contentHash ON share_codes(contentHash);
    CREATE INDEX IF NOT EXISTS idx_savedAt ON share_codes(savedAt);
  `);

  return db;
}

export interface StoredPayload {
  targetVersion: string;
  loader: string;
  items: unknown[];
  contentHash: string;
  savedAt: string;
}

export function getShareCode(code: string): StoredPayload | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM share_codes WHERE id = ?");
  const row = stmt.get(code.toUpperCase()) as any;
  
  if (!row) return null;
  
  return {
    targetVersion: row.targetVersion,
    loader: row.loader,
    items: JSON.parse(row.items),
    contentHash: row.contentHash,
    savedAt: row.savedAt,
  };
}

export function saveShareCode(
  code: string,
  payload: StoredPayload
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO share_codes 
    (id, targetVersion, loader, items, contentHash, savedAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  stmt.run(
    code.toUpperCase(),
    payload.targetVersion,
    payload.loader,
    JSON.stringify(payload.items),
    payload.contentHash,
    payload.savedAt,
    now
  );
}

export function findShareCodeByHash(contentHash: string): string | null {
  const db = getDb();
  const stmt = db.prepare("SELECT id FROM share_codes WHERE contentHash = ? LIMIT 1");
  const row = stmt.get(contentHash) as any;
  return row?.id || null;
}

export function deleteOldShareCodes(daysOld: number = 90): number {
  const db = getDb();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  const stmt = db.prepare(
    "DELETE FROM share_codes WHERE createdAt < ?"
  );
  const result = stmt.run(cutoffDate.toISOString());
  return result.changes;
}
