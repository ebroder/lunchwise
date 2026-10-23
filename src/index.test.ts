import { describe, it, expect, vi, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import worker from "./index.js";
import { encrypt, resetKeyCache } from "./lib/crypto.js";
import { getSharedDb, getUserDb, initUserDb, type SharedDb, type UserDb } from "./lib/db.js";
import { initEnv } from "./lib/env.js";
import { countedFetch, REQUEST_BUDGET, REQUEST_WARNING } from "./lib/request-budget.js";
import * as sharedSchema from "./lib/schema-shared.js";
import * as userSchema from "./lib/schema-user.js";
import { getAllExpenses } from "./lib/splitwise.js";
import { syncUser } from "./lib/sync.js";
import {
  enqueueUserSyncs,
  SYNC_DEAD_LETTER_QUEUE,
  SYNC_QUEUE,
  type UserSyncMessage,
} from "./lib/sync-queue.js";

vi.mock("./app.js", () => ({
  app: {
    fetch: async () => {
      throw new Error("handler failed");
    },
  },
}));

vi.mock("./lib/sync.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/sync.js")>();
  return { ...mod, syncUser: vi.fn() };
});

vi.mock("./lib/db.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/db.js")>();
  return { ...mod, getSharedDb: vi.fn(), getUserDb: vi.fn() };
});

vi.mock("./lib/splitwise.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/splitwise.js")>();
  return { ...mod, getAllExpenses: vi.fn() };
});

vi.mock("./lib/sync-queue.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/sync-queue.js")>();
  return { ...mod, enqueueUserSyncs: vi.fn() };
});

const { syncUser: realSyncUser } =
  await vi.importActual<typeof import("./lib/sync.js")>("./lib/sync.js");

const SENTRY_HOST = "sentry.example.com";

const workerEnv = {
  SYNC_QUEUE: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
  SENTRY_DSN: `https://public@${SENTRY_HOST}/1`,
  SESSION_SECRET: "a".repeat(32),
  TURSO_SHARED_DB_URL: "libsql://test.turso.io",
  TURSO_AUTH_TOKEN: "token",
  SPLITWISE_CLIENT_ID: "client-id",
  SPLITWISE_CLIENT_SECRET: "client-secret",
  APP_URL: "https://example.com",
  ENCRYPTION_KEYS: JSON.stringify({ "1": btoa("k".repeat(32)) }),
  TURSO_PLATFORM_API_TOKEN: "platform-token",
  TURSO_ORG: "test-org",
  TURSO_GROUP: "test-group",
};

async function sentryEnvelopesFor(request: Request): Promise<string[]> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  await expect(worker.fetch?.(request, workerEnv, ctx)).rejects.toThrow("handler failed");
  await Promise.all(pending);

  const decoder = new TextDecoder();
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes(SENTRY_HOST))
    .map(([, init]) => {
      const body = init?.body;
      return typeof body === "string" ? body : decoder.decode(body as Uint8Array);
    });
}

// Like the Workers runtime, drops Sentry sends still in flight once the handler and every
// waitUntil promise have settled. Check-ins take longer than other sends, so one only counts
// if a waitUntil covers it, not a concurrent send that happens to keep the invocation alive.
function fakeRuntime() {
  let invocationEnded = false;
  const delivered: string[] = [];
  const decoder = new TextDecoder();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = init?.body;
    const text = typeof body === "string" ? body : decoder.decode(body as Uint8Array);
    await new Promise((r) => {
      setTimeout(r, text.includes('"check_in"') ? 30 : 10);
    });
    if (!invocationEnded && String(url).includes(SENTRY_HOST)) {
      delivered.push(text);
    }
    return new Response("{}");
  });

  return {
    delivered,
    fetches: () => fetchSpy.mock.calls.length,
    async run(invoke: (ctx: ExecutionContext) => unknown): Promise<void> {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext;

      pending.push(Promise.resolve(invoke(ctx)));
      for (let settled = 0; settled < pending.length; ) {
        const batch = pending.slice(settled);
        settled = pending.length;
        await Promise.allSettled(batch);
        await new Promise((r) => {
          setTimeout(r, 0);
        });
      }
      invocationEnded = true;
    },
  };
}

function sentryItems(envelopes: string[]): Record<string, unknown>[] {
  return envelopes
    .flatMap((envelope) => envelope.split("\n"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function cronCheckIns(
  syncOutcome: "ok" | "error",
): Promise<{ duringSync: string[]; delivered: string[] }> {
  const runtime = fakeRuntime();
  const statuses = () =>
    sentryItems(runtime.delivered).flatMap((item) =>
      item.monitor_slug === "lunchwise-sync" && item.status ? [item.status as string] : [],
    );
  let duringSync: string[] = [];
  vi.mocked(enqueueUserSyncs).mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          duringSync = statuses();
          if (syncOutcome === "ok") resolve();
          else reject(new Error("sync failed"));
        }, 200);
      }),
  );
  const controller = {
    cron: "0 */2 * * *",
    scheduledTime: Date.now(),
    noRetry: () => {},
  } as ScheduledController;

  await runtime.run((ctx) => worker.scheduled?.(controller, workerEnv, ctx));

  return { duringSync, delivered: statuses() };
}

async function queueInvocation(
  sync: typeof syncUser,
  queue = SYNC_QUEUE,
  body: UserSyncMessage = { userId: 7, exchangeRates: null },
) {
  vi.mocked(syncUser).mockImplementation(sync);
  const message = {
    id: "msg",
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch: MessageBatch<UserSyncMessage> = {
    queue,
    messages: [message],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  const runtime = fakeRuntime();

  await runtime.run((ctx) => worker.queue?.(batch, workerEnv, ctx));

  return { message, delivered: runtime.delivered, fetches: runtime.fetches() };
}

// User 7 with one enabled link. In-memory databases make no requests, so they don't count.
async function seedUserWithLink(): Promise<UserDb> {
  initEnv(workerEnv);
  resetKeyCache();

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
  await shared
    .insert(sharedSchema.users)
    .values({ id: 7, splitwiseUserId: "123", tursoDbUrl: "libsql://user-7.example" });

  const userDb = drizzle({
    client: createClient({ url: ":memory:" }),
    schema: userSchema,
  }) as UserDb;
  await initUserDb(userDb);
  await userDb.insert(userSchema.credentials).values({
    splitwiseAccessToken: await encrypt("sw-token"),
    lunchMoneyApiKey: await encrypt("lm-key"),
  });
  await userDb
    .insert(userSchema.links)
    .values({ splitwiseGroupId: "10", lmAccountId: 100, lastSyncedAt: "2026-01-01T00:00:00Z" });

  vi.mocked(getSharedDb).mockReturnValue(shared as SharedDb);
  vi.mocked(getUserDb).mockReturnValue(userDb);
  return userDb;
}

async function makeRequests(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await countedFetch("https://api.example.com/");
  }
}

describe("Sentry reports", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leave out request bodies and client IPs", async () => {
    const envelopes = await sentryEnvelopesFor(
      new Request("https://lunchwise.example.com/api/settings/lunch-money", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ apiKey: "lm-secret-key" }),
      }),
    );

    expect(envelopes.some((envelope) => envelope.includes("handler failed"))).toBe(true);
    const sent = envelopes.join("\n");
    expect(sent).not.toContain("lm-secret-key");
    expect(sent).not.toContain("203.0.113.7");
  });

  it.each(["ok", "error"] as const)(
    "send the cron's in_progress check-in during the sync and its %s check-in after",
    async (status) => {
      expect(await cronCheckIns(status)).toEqual({
        duringSync: ["in_progress"],
        delivered: ["in_progress", status],
      });
    },
  );

  it("deliver a queue consumer's errors", async () => {
    const { message, delivered } = await queueInvocation(async () => {
      throw new Error("Turso unavailable");
    });

    expect(message.retry).toHaveBeenCalled();
    expect(delivered.join("\n")).toContain("Turso unavailable");
  });

  it("deliver the request budget warning as a Sentry warning with a fixed fingerprint", async () => {
    const { delivered } = await queueInvocation(() => makeRequests(REQUEST_WARNING + 1));

    expect(sentryItems(delivered)).toContainEqual(
      expect.objectContaining({
        level: "warning",
        fingerprint: ["request-budget-warning"],
        extra: { source: "queue", userId: 7, requests: REQUEST_WARNING + 1 },
      }),
    );
  });

  it("report a user who ran out of requests once, within the Free plan's 50 subrequests", async () => {
    const userDb = await seedUserWithLink();
    vi.mocked(getAllExpenses).mockImplementation(async () => {
      for (;;) {
        await countedFetch("https://secure.splitwise.com/api/v3.0/get_expenses");
      }
    });

    const { message, delivered, fetches } = await queueInvocation(realSyncUser);

    expect(message.ack).toHaveBeenCalled();
    const errors = sentryItems(delivered).flatMap((item) =>
      item.level === "error"
        ? [(item.exception as { values: { value: string }[] }).values[0].value]
        : [],
    );
    expect(errors).toEqual([
      `Sync for user 7 ran out of requests after ${REQUEST_BUDGET} requests`,
    ]);
    expect(fetches).toBeLessThanOrEqual(50);
    const syncLogs = await userDb.select().from(userSchema.syncLog);
    expect(syncLogs.map((row) => row.status)).toEqual(["running"]);
  });

  it("deliver a dead-lettered sync's report with the user id and nothing else from the message", async () => {
    const { message, delivered } = await queueInvocation(async () => {}, SYNC_DEAD_LETTER_QUEUE, {
      userId: 7,
      exchangeRates: { XTS: 98765.4321 },
    });

    expect(message.ack).toHaveBeenCalled();
    expect(syncUser).not.toHaveBeenCalled();
    const sent = delivered.join("\n");
    expect(sent).toContain("User 7's sync failed repeatedly");
    expect(sent).not.toContain("98765");
  });
});
