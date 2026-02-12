import path from "path";
import os from "os";
import fs from "fs";

let db: any = null;

function isVercelEnvironment(): boolean {
  return process.env.VERCEL === "1" || !!process.env.KV_REST_API_URL;
}

async function getKvDb(): Promise<any> {
  const { kv } = await import("@vercel/kv");
  return kv;
}

function getDbPath(): string {
  if (process.env.DATABASE_PATH) {
    const envPath = process.env.DATABASE_PATH;
    const envDir = path.dirname(envPath);
    if (!fs.existsSync(envDir)) {
      try {
        fs.mkdirSync(envDir, { recursive: true });
      } catch (e) {
        console.error("Failed to create database directory:", envDir, e);
      }
    }
    return envPath;
  }

  if (process.env.NODE_ENV === "production") {
    const dataDir = path.join(os.homedir(), ".minecraft-mod-converter");
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (e) {
        console.error("Failed to create database directory:", dataDir, e);
      }
    }
    return path.join(dataDir, "modlist-share-codes.db");
  }

  const dataDir = path.join(os.homedir(), ".minecraft-mod-converter-dev");
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (e) {
      console.error("Failed to create database directory:", dataDir, e);
    }
  }
  return path.join(dataDir, "modlist-share-codes.db");
}

export async function getDb(): Promise<any> {
  if (db) return db;

  if (isVercelEnvironment()) {
    console.log("Using Vercel KV for storage");
    db = await getKvDb();
  } else {
    console.log("Using SQLite for storage");
    const Database = (await import("better-sqlite3")).default;
    const dbPath = getDbPath();
    console.log("Opening database at:", dbPath);
    
    try {
      db = new Database(dbPath);
      db.pragma("journal_mode = WAL");

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

      console.log("Database initialized successfully");
    } catch (error) {
      console.error("Failed to initialize database:", error);
      throw error;
    }
  }

  return db;
}

export interface StoredPayload {
  targetVersion: string;
  loader: string;
  items: unknown[];
  contentHash: string;
  savedAt: string;
}

export async function getShareCode(code: string): Promise<StoredPayload | null> {
  const database = await getDb();
  const isKv = isVercelEnvironment();

  if (isKv) {
    const key = `share_code:${code.toUpperCase()}`;
    try {
      const data = await database.get(key);
      if (!data) return null;
      return JSON.parse(typeof data === "string" ? data : JSON.stringify(data));
    } catch (error) {
      console.error("Failed to get share code from KV:", error);
      return null;
    }
  } else {
    const stmt = database.prepare("SELECT * FROM share_codes WHERE id = ?");
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
}

export async function saveShareCode(
  code: string,
  payload: StoredPayload
): Promise<void> {
  const database = await getDb();
  const isKv = isVercelEnvironment();

  if (isKv) {
    const key = `share_code:${code.toUpperCase()}`;
    const ttl = 90 * 24 * 60 * 60;
    try {
      await database.setex(key, ttl, JSON.stringify({
        ...payload,
        createdAt: new Date().toISOString(),
      }));
      
      const hashKey = `share_code_hash:${payload.contentHash}`;
      await database.setex(hashKey, ttl, code.toUpperCase());
    } catch (error) {
      console.error("Failed to save share code to KV:", error);
      throw error;
    }
  } else {
    const stmt = database.prepare(`
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
}

export async function findShareCodeByHash(contentHash: string): Promise<string | null> {
  const database = await getDb();
  const isKv = isVercelEnvironment();

  if (isKv) {
    const key = `share_code_hash:${contentHash}`;
    try {
      const code = await database.get(key);
      return code ? String(code) : null;
    } catch (error) {
      console.error("Failed to find share code by hash:", error);
      return null;
    }
  } else {
    const stmt = database.prepare("SELECT id FROM share_codes WHERE contentHash = ? LIMIT 1");
    const row = stmt.get(contentHash) as any;
    return row ? row.id : null;
  }
}

export async function deleteOldShareCodes(daysOld: number = 90): Promise<number> {
  const database = await getDb();
  const isKv = isVercelEnvironment();

  if (isKv) {
    console.log("Vercel KV handles TTL automatically");
    return 0;
  } else {
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = database.prepare(
      "DELETE FROM share_codes WHERE createdAt < ?"
    );
    const info = stmt.run(cutoffDate) as any;
    return info.changes || 0;
  }
}
