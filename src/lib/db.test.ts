import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as userSchema from "./schema-user.js";
import { credentials, links, syncedTransactions } from "./schema-user.js";
import { initUserDb, type UserDb } from "./db.js";

describe("initUserDb", () => {
  it("adds credential timestamps to a database created before them", async () => {
    const client = createClient({ url: ":memory:" });
    await client.batch([
      `CREATE TABLE credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id = 1),
        splitwise_access_token TEXT NOT NULL,
        lunch_money_api_key TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `INSERT INTO credentials (splitwise_access_token, lunch_money_api_key) VALUES ('tok', 'key')`,
      `CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`,
      `INSERT INTO schema_version (id, version) VALUES (1, 1)`,
    ]);
    const db = drizzle({ client, schema: userSchema }) as UserDb;

    await initUserDb(db);

    expect(await db.select().from(credentials)).toEqual([
      expect.objectContaining({
        lunchMoneyApiKey: "key",
        lunchMoneyKeyUpdatedAt: null,
        splitwiseTokenUpdatedAt: null,
      }),
    ]);
  });

  it("adds catch-up bookmarks and backfill amounts to a database created before them", async () => {
    const client = createClient({ url: ":memory:" });
    await client.batch([
      `CREATE TABLE links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        splitwise_group_id TEXT,
        lm_account_id INTEGER NOT NULL,
        start_date TEXT,
        include_payments INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        sync_balance INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE synced_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id INTEGER NOT NULL REFERENCES links(id),
        splitwise_expense_id TEXT NOT NULL,
        lm_transaction_id INTEGER NOT NULL,
        splitwise_updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `INSERT INTO links (lm_account_id, last_synced_at) VALUES (100, '2026-10-01T00:00:00.000Z')`,
      `INSERT INTO synced_transactions (link_id, splitwise_expense_id, lm_transaction_id, splitwise_updated_at)
        VALUES (1, '1001', 9001, 'backfill')`,
      `CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`,
      `INSERT INTO schema_version (id, version) VALUES (1, 2)`,
    ]);
    const db = drizzle({ client, schema: userSchema }) as UserDb;

    await initUserDb(db);

    expect(await db.select().from(links)).toEqual([
      expect.objectContaining({
        lastSyncedAt: "2026-10-01T00:00:00.000Z",
        catchUpOffset: null,
        catchUpStartedAt: null,
      }),
    ]);
    expect(await db.select().from(syncedTransactions)).toEqual([
      expect.objectContaining({ splitwiseUpdatedAt: "backfill", backfillAmount: null }),
    ]);
    const { rows } = await client.execute("SELECT version FROM schema_version");
    expect(rows).toEqual([expect.objectContaining({ version: 3 })]);
  });

  it("creates a fresh database at the latest version", async () => {
    const client = createClient({ url: ":memory:" });
    const db = drizzle({ client, schema: userSchema }) as UserDb;

    await initUserDb(db);
    await db.insert(links).values({ lmAccountId: 100, catchUpOffset: 4000 });

    expect(await db.select().from(links)).toEqual([
      expect.objectContaining({ catchUpOffset: 4000 }),
    ]);
    const { rows } = await client.execute("SELECT version FROM schema_version");
    expect(rows).toEqual([expect.objectContaining({ version: 3 })]);
  });
});
