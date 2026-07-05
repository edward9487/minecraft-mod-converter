import path from "path";
import os from "os";
import fs from "fs";

type KvStore = {
  get(key: string): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
};

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes?: number };
};

type SqliteStore = {
  prepare(sql: string): SqliteStatement;
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
};

type JsonFileStore = {
  kind: "json";
  path: string;
};

type DatabaseStore = KvStore | SqliteStore | JsonFileStore;
type DatabaseKind = "kv" | "sqlite" | "json";

type ShareCodeRow = {
  id: string;
  targetVersion: string;
  loader: string;
  items: string;
  contentHash: string;
  savedAt: string;
  createdAt: string;
};

let db: DatabaseStore | null = null;
let dbKind: DatabaseKind | null = null;

function isVercelEnvironment(): boolean {
  return process.env.VERCEL === "1" || !!process.env.KV_REST_API_URL;
}

async function getKvDb(): Promise<KvStore> {
  const { kv } = await import("@vercel/kv");
  return kv as KvStore;
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

function getJsonDbPath(): string {
  const sqlitePath = getDbPath();
  return sqlitePath.replace(/\.db$/i, ".json");
}

function createJsonFileStore(error?: unknown): JsonFileStore {
  if (error) {
    console.warn("SQLite unavailable, using JSON file storage:", error);
  }
  const jsonPath = getJsonDbPath();
  const dir = path.dirname(jsonPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(jsonPath)) {
    fs.writeFileSync(jsonPath, JSON.stringify({ shareCodes: {} }, null, 2), "utf8");
  }
  return { kind: "json", path: jsonPath };
}

function readJsonStore(store: JsonFileStore): Record<string, StoredPayload & { createdAt?: string }> {
  try {
    const raw = fs.readFileSync(store.path, "utf8");
    const data = JSON.parse(raw) as { shareCodes?: Record<string, StoredPayload & { createdAt?: string }> };
    return data.shareCodes ?? {};
  } catch {
    return {};
  }
}

function writeJsonStore(
  store: JsonFileStore,
  shareCodes: Record<string, StoredPayload & { createdAt?: string }>
) {
  fs.writeFileSync(store.path, JSON.stringify({ shareCodes }, null, 2), "utf8");
}

export async function getDb(): Promise<DatabaseStore> {
  if (db) return db;

  if (isVercelEnvironment()) {
    console.log("Using Vercel KV for storage");
    db = await getKvDb();
    dbKind = "kv";
  } else {
    console.log("Using SQLite for storage");
    try {
      const Database = (await import("better-sqlite3")).default;
      const dbPath = getDbPath();
      console.log("Opening database at:", dbPath);
      const sqlite = new Database(dbPath) as SqliteStore;
      db = sqlite;
      dbKind = "sqlite";
      sqlite.pragma("journal_mode = WAL");

      sqlite.exec(`
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
      db = createJsonFileStore(error);
      dbKind = "json";
    }
  }

  return db;
}

async function getDbKind(): Promise<DatabaseKind> {
  await getDb();
  return dbKind ?? "sqlite";
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
  const kind = await getDbKind();

  if (kind === "kv") {
    const key = `share_code:${code.toUpperCase()}`;
    try {
      const kv = database as KvStore;
      const data = await kv.get(key);
      if (!data) return null;
      return JSON.parse(typeof data === "string" ? data : JSON.stringify(data));
    } catch (error) {
      console.error("Failed to get share code from KV:", error);
      return null;
    }
  }

  if (kind === "json") {
    const store = database as JsonFileStore;
    const shareCodes = readJsonStore(store);
    return shareCodes[code.toUpperCase()] ?? null;
  }

  {
    const sqlite = database as SqliteStore;
    const stmt = sqlite.prepare("SELECT * FROM share_codes WHERE id = ?");
    const row = stmt.get(code.toUpperCase()) as ShareCodeRow | undefined;
    
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
  const kind = await getDbKind();

  if (kind === "kv") {
    const key = `share_code:${code.toUpperCase()}`;
    const ttl = 90 * 24 * 60 * 60;
    try {
      const kv = database as KvStore;
      await kv.setex(key, ttl, JSON.stringify({
        ...payload,
        createdAt: new Date().toISOString(),
      }));
      
      const hashKey = `share_code_hash:${payload.contentHash}`;
      await kv.setex(hashKey, ttl, code.toUpperCase());
    } catch (error) {
      console.error("Failed to save share code to KV:", error);
      throw error;
    }
    return;
  }

  if (kind === "json") {
    const store = database as JsonFileStore;
    const shareCodes = readJsonStore(store);
    shareCodes[code.toUpperCase()] = {
      ...payload,
      savedAt: payload.savedAt,
      createdAt: new Date().toISOString(),
    };
    writeJsonStore(store, shareCodes);
    return;
  }

  {
    const sqlite = database as SqliteStore;
    const stmt = sqlite.prepare(`
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
  const kind = await getDbKind();

  if (kind === "kv") {
    const key = `share_code_hash:${contentHash}`;
    try {
      const kv = database as KvStore;
      const code = await kv.get(key);
      return code ? String(code) : null;
    } catch (error) {
      console.error("Failed to find share code by hash:", error);
      return null;
    }
  }

  if (kind === "json") {
    const store = database as JsonFileStore;
    const shareCodes = readJsonStore(store);
    const match = Object.entries(shareCodes).find(
      ([, payload]) => payload.contentHash === contentHash
    );
    return match?.[0] ?? null;
  }

  {
    const sqlite = database as SqliteStore;
    const stmt = sqlite.prepare("SELECT id FROM share_codes WHERE contentHash = ? LIMIT 1");
    const row = stmt.get(contentHash) as Pick<ShareCodeRow, "id"> | undefined;
    return row ? row.id : null;
  }
}

export async function deleteOldShareCodes(daysOld: number = 90): Promise<number> {
  const database = await getDb();
  const kind = await getDbKind();

  if (kind === "kv") {
    console.log("Vercel KV handles TTL automatically");
    return 0;
  }

  if (kind === "json") {
    const store = database as JsonFileStore;
    const shareCodes = readJsonStore(store);
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [code, payload] of Object.entries(shareCodes)) {
      const createdAt = payload.createdAt ? Date.parse(payload.createdAt) : Date.parse(payload.savedAt);
      if (Number.isFinite(createdAt) && createdAt < cutoff) {
        delete shareCodes[code];
        removed++;
      }
    }
    if (removed) writeJsonStore(store, shareCodes);
    return removed;
  }

  {
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const sqlite = database as SqliteStore;
    const stmt = sqlite.prepare(
      "DELETE FROM share_codes WHERE createdAt < ?"
    );
    const info = stmt.run(cutoffDate);
    return info.changes || 0;
  }
}
