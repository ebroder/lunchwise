import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as userSchema from "./schema-user.js";
import { credentials } from "./schema-user.js";
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
});
