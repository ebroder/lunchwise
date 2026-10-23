import { describe, it, expect, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as userSchema from "./schema-user.js";
import { credentials, links, syncLog } from "./schema-user.js";
import { initUserDb, type UserDb } from "./db.js";
import { INTERRUPTED_MESSAGE } from "./errors.js";
import { getSyncFailures } from "./sync-failure.js";

const LM_REJECTED = 'Lunch Money API error (401): {"message":"Unauthorized"}';
const SW_REJECTED = 'Splitwise API error (401): {"error":"Invalid API request"}';

describe("getSyncFailures", () => {
  let db: UserDb;

  async function addSync(
    linkId: number,
    startedAt: string,
    status: string,
    errorMessage: string | null = null,
  ) {
    await db.insert(syncLog).values({ linkId, startedAt, status, errorMessage });
  }

  beforeEach(async () => {
    db = drizzle({ client: createClient({ url: ":memory:" }), schema: userSchema }) as UserDb;
    await initUserDb(db);
    await db.insert(credentials).values({ splitwiseAccessToken: "tok", lunchMoneyApiKey: "key" });
    await db.insert(links).values([{ lmAccountId: 100 }, { lmAccountId: 200 }]);
  });

  it("explains a link's latest finished sync when it failed", async () => {
    await addSync(1, "2026-10-23T10:00:00.000Z", "success");
    await addSync(1, "2026-10-23T12:00:00.000Z", "error", LM_REJECTED);

    const failures = await getSyncFailures(db);

    expect(failures).toEqual(
      new Map([
        [
          1,
          {
            at: "2026-10-23T12:00:00.000Z",
            reason: "lunch-money-key",
            message:
              "Lunch Money no longer accepts your API key. Enter a new one under Connections.",
          },
        ],
      ]),
    );
  });

  it.each([
    [
      SW_REJECTED,
      "splitwise-access",
      "Splitwise no longer accepts Lunchwise's access. Log out and log back in.",
    ],
    [INTERRUPTED_MESSAGE, "interrupted", "It stopped before finishing."],
    ["Lunch Money API error (500): {}", "other", "See History for details."],
  ])("explains %s", async (errorMessage, reason, message) => {
    await addSync(2, "2026-10-23T12:00:00.000Z", "error", errorMessage);

    const failures = await getSyncFailures(db);

    expect(failures.get(2)).toEqual({ at: "2026-10-23T12:00:00.000Z", reason, message });
  });

  it("clears once a later sync succeeds", async () => {
    await addSync(1, "2026-10-23T10:00:00.000Z", "error", LM_REJECTED);
    await addSync(1, "2026-10-23T12:00:00.000Z", "success");
    await addSync(2, "2026-10-23T12:00:00.000Z", "error", "boom");

    const failures = await getSyncFailures(db);

    expect([...failures.keys()]).toEqual([2]);
  });

  it("ignores a sync still running", async () => {
    await addSync(1, "2026-10-23T10:00:00.000Z", "error", "boom");
    await addSync(1, "2026-10-23T12:00:00.000Z", "running");

    const failures = await getSyncFailures(db);

    expect(failures.get(1)?.at).toBe("2026-10-23T10:00:00.000Z");
  });

  it.each([
    ["Lunch Money key", LM_REJECTED, { lunchMoneyKeyUpdatedAt: "2026-10-23T12:30:00.000Z" }],
    ["Splitwise token", SW_REJECTED, { splitwiseTokenUpdatedAt: "2026-10-23T12:30:00.000Z" }],
  ])("drops a rejection of a %s replaced since", async (_name, errorMessage, replaced) => {
    await addSync(1, "2026-10-23T12:00:00.000Z", "error", errorMessage);
    await db.update(credentials).set(replaced);

    expect(await getSyncFailures(db)).toEqual(new Map());
  });

  it.each([
    ["Lunch Money", LM_REJECTED],
    ["Splitwise", SW_REJECTED],
  ])("drops a %s rejection once any link has synced since", async (_name, errorMessage) => {
    await addSync(1, "2026-10-23T12:00:00.000Z", "error", errorMessage);
    await addSync(2, "2026-10-23T12:00:01.000Z", "success");

    expect(await getSyncFailures(db)).toEqual(new Map());
  });

  it("keeps a rejection newer than another link's success", async () => {
    await addSync(2, "2026-10-23T11:59:59.000Z", "success");
    await addSync(1, "2026-10-23T12:00:00.000Z", "error", LM_REJECTED);

    const failures = await getSyncFailures(db);

    expect(failures.get(1)?.reason).toBe("lunch-money-key");
  });

  it("keeps any other failure after another link's success", async () => {
    await addSync(1, "2026-10-23T12:00:00.000Z", "error", INTERRUPTED_MESSAGE);
    await addSync(2, "2026-10-23T12:00:01.000Z", "success");

    const failures = await getSyncFailures(db);

    expect(failures.get(1)?.reason).toBe("interrupted");
  });

  it("keeps a rejection of the current key", async () => {
    await db.update(credentials).set({
      lunchMoneyKeyUpdatedAt: "2026-10-23T11:00:00.000Z",
      splitwiseTokenUpdatedAt: "2026-10-23T12:30:00.000Z",
    });
    await addSync(1, "2026-10-23T12:00:00.000Z", "error", LM_REJECTED);

    const failures = await getSyncFailures(db);

    expect(failures.get(1)?.reason).toBe("lunch-money-key");
  });
});
