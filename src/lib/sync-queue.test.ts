import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import * as sharedSchema from "./schema-shared.js";
import { getSharedDb, type SharedDb } from "./db.js";
import { getExchangeRates, type ExchangeRates } from "./exchange-rates.js";
import { createLogger, type Logger } from "./logger.js";
import { countedFetch, REQUEST_BUDGET, REQUEST_WARNING } from "./request-budget.js";
import { syncUser } from "./sync.js";
import {
  enqueueUserSyncs,
  processSyncBatch,
  SYNC_QUEUE,
  type UserSyncMessage,
} from "./sync-queue.js";

vi.mock("./db.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./db.js")>();
  return { ...mod, getSharedDb: vi.fn() };
});

vi.mock("./exchange-rates.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./exchange-rates.js")>();
  return { ...mod, getExchangeRates: vi.fn() };
});

vi.mock("./sync.js", () => ({ syncUser: vi.fn() }));

vi.mock("./logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), with: vi.fn() };
  return { createLogger: vi.fn(() => log) };
});

const log = vi.mocked(createLogger()) as { [K in keyof Logger]: ReturnType<typeof vi.fn> };

// About the size of open.er-api.com's real rate table.
const RATES: ExchangeRates = Object.fromEntries(
  Array.from({ length: 170 }, (_, i) => [`C${String(i).padStart(2, "0")}`, 1234.5678 + i]),
);

async function sharedDbWithUsers(urls: (string | null)[]): Promise<SharedDb> {
  const shared = drizzle({ client: createClient({ url: ":memory:" }), schema: sharedSchema });
  await shared.run(sql`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      splitwise_user_id TEXT NOT NULL UNIQUE,
      turso_db_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  if (urls.length > 0) {
    await shared
      .insert(sharedSchema.users)
      .values(urls.map((tursoDbUrl, i) => ({ splitwiseUserId: `sw-${i}`, tursoDbUrl })));
  }
  return shared as SharedDb;
}

function fakeQueue() {
  return { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() };
}

function fakeMessage(body: UserSyncMessage) {
  return { id: "msg", timestamp: new Date(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}

function fakeBatch(message: ReturnType<typeof fakeMessage>): MessageBatch<UserSyncMessage> {
  return {
    queue: SYNC_QUEUE,
    messages: [message],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

async function makeRequests(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await countedFetch("https://example.com/");
  }
}

describe("enqueueUserSyncs", () => {
  beforeEach(() => {
    vi.mocked(getExchangeRates).mockReset().mockResolvedValue(RATES);
  });

  it("queues one message per user with a database, carrying the exchange rates", async () => {
    vi.mocked(getSharedDb).mockReturnValue(
      await sharedDbWithUsers(["libsql://a.example", null, "libsql://c.example"]),
    );
    const queue = fakeQueue();

    await enqueueUserSyncs(queue);

    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(queue.sendBatch.mock.calls[0][0]).toEqual([
      { body: { userId: 1, exchangeRates: RATES } },
      { body: { userId: 3, exchangeRates: RATES } },
    ]);
  });

  it("queues users without exchange rates when they fail to load", async () => {
    vi.mocked(getSharedDb).mockReturnValue(await sharedDbWithUsers(["libsql://a.example"]));
    vi.mocked(getExchangeRates).mockRejectedValue(new Error("rates API down"));
    const queue = fakeQueue();

    await enqueueUserSyncs(queue);

    expect(queue.sendBatch.mock.calls[0][0]).toEqual([
      { body: { userId: 1, exchangeRates: null } },
    ]);
  });

  it("splits the messages into sendBatch calls within Cloudflare's limits", async () => {
    const urls = Array.from({ length: 230 }, (_, i) => `libsql://user-${i}.example`);
    vi.mocked(getSharedDb).mockReturnValue(await sharedDbWithUsers(urls));
    const queue = fakeQueue();

    await enqueueUserSyncs(queue);

    const calls = queue.sendBatch.mock.calls.map(([messages]) => messages as unknown[]);
    for (const messages of calls) {
      expect(messages.length).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(JSON.stringify(messages)).length).toBeLessThan(256_000);
    }
    expect(calls.flat()).toHaveLength(230);
  });
});

describe("processSyncBatch", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    vi.mocked(syncUser).mockReset().mockResolvedValue();
    vi.mocked(createLogger).mockClear();
    for (const fn of Object.values(log)) fn.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs the user with the queued exchange rates, then acks", async () => {
    const message = fakeMessage({ userId: 7, exchangeRates: RATES });
    vi.mocked(syncUser).mockImplementation(() => makeRequests(3));

    await processSyncBatch(fakeBatch(message));

    expect(syncUser).toHaveBeenCalledWith(7, RATES);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(createLogger).toHaveBeenCalledWith({ source: "queue", userId: 7 });
    expect(log.info).toHaveBeenCalledWith("User sync finished", { requests: 3 });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("retries a user whose sync threw", async () => {
    const message = fakeMessage({ userId: 7, exchangeRates: null });
    const failure = new Error("Turso unavailable");
    vi.mocked(syncUser).mockRejectedValue(failure);

    await processSyncBatch(fakeBatch(message));

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "User sync failed, will retry",
      expect.objectContaining({ cause: failure }),
    );
  });

  it.each([
    ["threw", () => makeRequests(REQUEST_BUDGET + 1)],
    ["swallowed the refusal", () => makeRequests(REQUEST_BUDGET + 1).catch(() => {})],
  ])(
    "reports a user who ran out of requests and acks, since a retry would too (sync %s)",
    async (_, sync) => {
      const message = fakeMessage({ userId: 7, exchangeRates: null });
      vi.mocked(syncUser).mockImplementation(sync);

      await processSyncBatch(fakeBatch(message));

      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledTimes(1);
      const [msg, fields] = log.error.mock.calls[0];
      expect(msg).toContain("user 7");
      expect(msg).toContain(`${REQUEST_BUDGET} requests`);
      expect(fields).toEqual({ requests: REQUEST_BUDGET });
    },
  );

  it.each([
    [REQUEST_WARNING, false],
    [REQUEST_WARNING + 1, true],
  ])("with %i requests, warns Sentry under one fingerprint: %s", async (requests, warns) => {
    const message = fakeMessage({ userId: 7, exchangeRates: null });
    vi.mocked(syncUser).mockImplementation(() => makeRequests(requests));

    await processSyncBatch(fakeBatch(message));

    expect(message.ack).toHaveBeenCalled();
    if (warns) {
      expect(log.warn).toHaveBeenCalledWith(
        "User sync is close to the request budget",
        { requests },
        { fingerprint: ["request-budget-warning"] },
      );
    } else {
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

  it("counts each invocation from zero", async () => {
    vi.mocked(syncUser).mockImplementation(() => makeRequests(3));

    await processSyncBatch(fakeBatch(fakeMessage({ userId: 7, exchangeRates: null })));
    await processSyncBatch(fakeBatch(fakeMessage({ userId: 8, exchangeRates: null })));

    expect(log.info.mock.calls).toEqual([
      ["User sync finished", { requests: 3 }],
      ["User sync finished", { requests: 3 }],
    ]);
  });
});
