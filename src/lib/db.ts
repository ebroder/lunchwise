import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import * as sharedSchema from "./schema-shared.js";
import * as userSchema from "./schema-user.js";

// --- Types ---

export type SharedDb = ReturnType<typeof createSharedDrizzle>;
export type UserDb = ReturnType<typeof createUserDrizzle>;

// --- Shared DB (control plane) ---

function createSharedDrizzle() {
  const client = createClient({
    url: process.env.TURSO_SHARED_DB_URL || "file:local.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return drizzle({ client, schema: sharedSchema });
}

let sharedDb: SharedDb;

export function getSharedDb(): SharedDb {
  if (!sharedDb) {
    sharedDb = createSharedDrizzle();
  }
  return sharedDb;
}

// --- Per-user DB ---

function createUserDrizzle(url: string) {
  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return drizzle({ client, schema: userSchema });
}

// Simple LRU cache: Map preserves insertion order;
// evict the oldest entry when the cache exceeds maxSize.
const userDbCache = new Map<string, UserDb>();
const USER_DB_CACHE_MAX = 50;

export function getUserDb(url: string): UserDb {
  const cached = userDbCache.get(url);
  if (cached) {
    // Move to end (most recently used)
    userDbCache.delete(url);
    userDbCache.set(url, cached);
    return cached;
  }
  const db = createUserDrizzle(url);
  userDbCache.set(url, db);
  if (userDbCache.size > USER_DB_CACHE_MAX) {
    const oldest = userDbCache.keys().next().value!;
    userDbCache.delete(oldest);
  }
  return db;
}

// --- Schema initialization ---

export async function initSharedDb(): Promise<void> {
  const db = getSharedDb();
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      splitwise_user_id TEXT NOT NULL UNIQUE,
      turso_db_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log("Shared database schema initialized");
}

export async function initUserDb(db: UserDb): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      splitwise_access_token TEXT NOT NULL,
      lunch_money_api_key TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      splitwise_group_id TEXT,
      lm_account_id INTEGER NOT NULL,
      start_date TEXT,
      include_payments INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS synced_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id),
      splitwise_expense_id TEXT NOT NULL,
      lm_transaction_id INTEGER NOT NULL,
      splitwise_updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_synced_link_expense
      ON synced_transactions(link_id, splitwise_expense_id)
  `);
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      expenses_fetched INTEGER DEFAULT 0,
      created INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      error_message TEXT
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_sync_log_link_id
      ON sync_log(link_id, started_at DESC)
  `);
  await db.run(sql`
    UPDATE sync_log
    SET status = 'error', finished_at = datetime('now'), error_message = 'Process interrupted'
    WHERE status = 'running'
  `);
}

