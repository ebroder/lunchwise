import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "./app.js";
import worker from "./index.js";
import { markDbInitialized } from "./lib/auth.js";
import { encrypt, resetKeyCache } from "./lib/crypto.js";
import { getSharedDb, getUserDb, initUserDb, type SharedDb, type UserDb } from "./lib/db.js";
import { initEnv } from "./lib/env.js";
import { apiError } from "./lib/errors.js";
import { getExchangeRates } from "./lib/exchange-rates.js";
import { getUser } from "./lib/lunch-money.js";
import { countedFetch, REQUEST_BUDGET, REQUEST_WARNING } from "./lib/request-budget.js";
import * as sharedSchema from "./lib/schema-shared.js";
import * as userSchema from "./lib/schema-user.js";
import { EXPENSE_PAGE_SIZE, getExpenses } from "./lib/splitwise.js";
import { CATCH_UP_OVERLAP, EXPENSE_PAGES_PER_RUN, syncUser } from "./lib/sync.js";
import {
  enqueueUserSyncs,
  SYNC_DEAD_LETTER_QUEUE,
  SYNC_QUEUE,
  type UserSyncMessage,
} from "./lib/sync-queue.js";

vi.mock("./app.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./app.js")>();
  return { app: { fetch: vi.fn(mod.app.fetch) } };
});

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
  return { ...mod, getExpenses: vi.fn() };
});

vi.mock("./lib/lunch-money.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/lunch-money.js")>();
  return { ...mod, getUser: vi.fn() };
});

vi.mock("./lib/exchange-rates.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/exchange-rates.js")>();
  return { ...mod, getExchangeRates: vi.fn() };
});

vi.mock("./lib/sync-queue.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lib/sync-queue.js")>();
  return { ...mod, enqueueUserSyncs: vi.fn() };
});

const { syncUser: realSyncUser } =
  await vi.importActual<typeof import("./lib/sync.js")>("./lib/sync.js");
const { getExpenses: realGetExpenses } =
  await vi.importActual<typeof import("./lib/splitwise.js")>("./lib/splitwise.js");
const { getUser: realGetUser } =
  await vi.importActual<typeof import("./lib/lunch-money.js")>("./lib/lunch-money.js");

const SENTRY_HOST = "sentry.example.com";

const noExpenses = { expenses: [], nextOffset: null };

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
  vi.mocked(app.fetch).mockRejectedValueOnce(new Error("handler failed"));
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
function fakeRuntime(respond: typeof fetch = async () => new Response("{}")) {
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
    return respond(url, init);
  });

  // an earlier runtime in the same test shares the spy
  const firstCall = fetchSpy.mock.calls.length;
  const calls = () => fetchSpy.mock.calls.slice(firstCall);

  return {
    delivered,
    fetches: () => calls().length,
    sentrySends: () => calls().filter(([url]) => String(url).includes(SENTRY_HOST)).length,
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

function sentryWarningFingerprints(envelopes: string[]): unknown[] {
  return sentryItems(envelopes).flatMap((item) =>
    item.level === "warning" ? [item.fingerprint] : [],
  );
}

function sentryErrors(envelopes: string[]): string[] {
  return sentryItems(envelopes).flatMap((item) =>
    item.level === "error"
      ? [(item.exception as { values: { value: string }[] }).values[0].value]
      : [],
  );
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
  respond?: typeof fetch,
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
  const runtime = fakeRuntime(respond);

  await runtime.run((ctx) => worker.queue?.(batch, workerEnv, ctx));

  return {
    message,
    delivered: runtime.delivered,
    fetches: runtime.fetches(),
    requests: runtime.fetches() - runtime.sentrySends(),
  };
}

async function apiInvocation(method: string, path: string, json?: unknown, respond?: typeof fetch) {
  const session = await new SignJWT({ sub: "7" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(workerEnv.SESSION_SECRET));
  const request = new Request(`https://lunchwise.example.com${path}`, {
    method,
    headers: {
      cookie: `lunchwise_session=${session}`,
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const runtime = fakeRuntime(respond);
  let status = 0;
  let body: unknown;

  // Sentry flushes once the response body has been sent.
  await runtime.run(async (ctx) => {
    const response = await worker.fetch!(request, workerEnv, ctx);
    status = response.status;
    body = await response.json();
  });

  return {
    status,
    body,
    delivered: runtime.delivered,
    requests: runtime.fetches() - runtime.sentrySends(),
  };
}

// Like Turso's HTTP API, one request per query or batch.
function countQueries(client: Client): void {
  for (const method of ["execute", "batch"] as const) {
    const run = client[method].bind(client) as (...args: unknown[]) => Promise<unknown>;
    Object.assign(client, {
      [method]: async (...args: unknown[]) => {
        await countedFetch("https://db.example.turso.io/v2/pipeline");
        return run(...args);
      },
    });
  }
}

// User 7 with one enabled link, link 1 unless `link` says otherwise.
async function seedUserWithLink(
  link: Partial<typeof userSchema.links.$inferInsert> = {},
  syncs: (typeof userSchema.syncLog.$inferInsert)[] = [],
): Promise<UserDb> {
  initEnv(workerEnv);
  resetKeyCache();

  const sharedClient = createClient({ url: ":memory:" });
  const shared = drizzle({ client: sharedClient, schema: sharedSchema });
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

  const userClient = createClient({ url: ":memory:" });
  const userDb = drizzle({ client: userClient, schema: userSchema }) as UserDb;
  await initUserDb(userDb);
  await userDb.insert(userSchema.credentials).values({
    splitwiseAccessToken: await encrypt("sw-token"),
    lunchMoneyApiKey: await encrypt("lm-key"),
  });
  await userDb.insert(userSchema.links).values({
    splitwiseGroupId: "10",
    lmAccountId: 100,
    lastSyncedAt: "2026-01-01T00:00:00Z",
    ...link,
  });
  if (syncs.length > 0) await userDb.insert(userSchema.syncLog).values(syncs);

  countQueries(sharedClient);
  countQueries(userClient);
  vi.mocked(getSharedDb).mockReturnValue(shared as SharedDb);
  vi.mocked(getUserDb).mockReturnValue(userDb);
  return userDb;
}

async function makeRequests(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await countedFetch("https://api.example.com/");
  }
}

async function exhaustRequests(): Promise<never> {
  for (let i = 0; i <= REQUEST_BUDGET; i++) {
    await countedFetch("https://api.example.com/");
  }
  throw new Error("No request was refused");
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

  it("wait until a request's handler has returned", async () => {
    const runtime = fakeRuntime();
    let sentDuringHandler = -1;
    vi.mocked(app.fetch).mockImplementationOnce(async () => {
      Sentry.captureMessage("captured mid-request");
      await countedFetch("https://api.example.com/");
      sentDuringHandler = runtime.sentrySends();
      return new Response("ok");
    });

    await runtime.run(async (ctx) => {
      const response = await worker.fetch!(
        new Request("https://lunchwise.example.com/"),
        workerEnv,
        ctx,
      );
      await response.text();
    });

    expect(sentDuringHandler).toBe(0);
    expect(runtime.delivered.join("\n")).toContain("captured mid-request");
  });

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
    vi.mocked(getExpenses).mockImplementation(exhaustRequests);

    const { message, delivered, fetches } = await queueInvocation(realSyncUser);

    expect(message.ack).toHaveBeenCalled();
    expect(sentryErrors(delivered)).toEqual([
      `Sync for user 7 ran out of requests after ${REQUEST_BUDGET} requests`,
    ]);
    expect(fetches).toBeLessThanOrEqual(50);
    const syncLogs = await userDb.select().from(userSchema.syncLog);
    expect(syncLogs.map((row) => row.status)).toEqual(["running"]);
  });

  it("deliver credentials rejected during a queued sync as Sentry warnings, not errors", async () => {
    await seedUserWithLink({ syncBalance: 1 });
    vi.mocked(getExpenses).mockRejectedValue(
      apiError("Splitwise", 401, { error: "Invalid API request: you are not logged in" }),
    );
    vi.mocked(getUser).mockRejectedValue(apiError("Lunch Money", 401, { message: "Unauthorized" }));

    const { message, delivered } = await queueInvocation(realSyncUser, SYNC_QUEUE, {
      userId: 7,
      exchangeRates: { USD: 1 },
    });

    expect(message.ack).toHaveBeenCalled();
    expect(sentryErrors(delivered)).toEqual([]);
    expect(sentryWarningFingerprints(delivered)).toEqual([
      ["sync-credential-rejected", "splitwise-access"],
      ["sync-credential-rejected", "lunch-money-key"],
    ]);
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

describe("Sync now and dry run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Sentry's per-isolate client drops an event identical to the one before it, so each case
  // syncs a different link.
  it.each([
    { route: "Sync now", phase: "expenses", linkId: 1 },
    { route: "Sync now", phase: "balance", linkId: 2 },
    { route: "dry run", phase: "expenses", linkId: 3 },
    { route: "dry run", phase: "balance", linkId: 4 },
  ])(
    "$route reports running out of requests in $phase once, within the Free plan's 50 subrequests",
    async ({ route, phase, linkId }) => {
      await seedUserWithLink({ id: linkId, syncBalance: 1 });
      vi.mocked(getExchangeRates).mockResolvedValue({ USD: 1 });
      if (phase === "expenses") {
        vi.mocked(getExpenses).mockImplementation(exhaustRequests);
      } else {
        vi.mocked(getExpenses).mockResolvedValue(noExpenses);
        vi.mocked(getUser).mockImplementation(exhaustRequests);
      }

      const { status, body, delivered, requests } =
        route === "Sync now"
          ? await apiInvocation("POST", `/api/sync/${linkId}`)
          : await apiInvocation("GET", `/api/links/${linkId}/dry-run`);

      expect(status).toBe(500);
      expect(body).toEqual({
        error:
          route === "Sync now"
            ? "This sync was too large to finish in one go and stopped partway."
            : "This dry run was too large to finish in one go.",
      });
      const name = route === "Sync now" ? "Sync" : "Dry run";
      expect(sentryErrors(delivered)).toEqual([
        `${name} for user 7, link ${linkId} ran out of requests after ${REQUEST_BUDGET} requests`,
      ]);
      // the budget covers authentication's queries too
      expect(requests).toBe(REQUEST_BUDGET);
    },
  );

  it("Sync now returns its counts", async () => {
    await seedUserWithLink();
    vi.mocked(getExpenses).mockResolvedValue(noExpenses);

    const { status, body, delivered } = await apiInvocation("POST", "/api/sync/1");

    expect(body).toEqual({ created: 0, updated: 0, deleted: 0, more_to_sync: false });
    expect(status).toBe(200);
    expect(sentryErrors(delivered)).toEqual([]);
  });

  it("Sync now explains a rejected credential and reports it as a Sentry warning", async () => {
    await seedUserWithLink({ id: 5 });
    vi.mocked(getExpenses).mockRejectedValue(
      apiError("Splitwise", 401, { error: "Invalid API request: you are not logged in" }),
    );

    const { status, body, delivered } = await apiInvocation("POST", "/api/sync/5");

    expect(status).toBe(500);
    expect(body).toEqual({
      error:
        "Sync failed. Splitwise no longer accepts Lunchwise's access. Log out and log back in.",
    });
    expect(sentryErrors(delivered)).toEqual([]);
    expect(sentryWarningFingerprints(delivered)).toEqual([
      ["sync-credential-rejected", "splitwise-access"],
    ]);
  });

  it("Sync now points to History for any other failure", async () => {
    await seedUserWithLink({ id: 6 });
    vi.mocked(getExpenses).mockRejectedValue(apiError("Splitwise", 503, "Service Unavailable"));

    const { status, body, delivered } = await apiInvocation("POST", "/api/sync/6");

    expect(status).toBe(500);
    expect(body).toEqual({ error: "Sync failed. See History for details." });
    expect(sentryErrors(delivered)).toEqual(["Splitwise API error (503): Service Unavailable"]);
  });

  it("dry run reports a rejected credential as a Sentry warning", async () => {
    await seedUserWithLink({ id: 8 });
    vi.mocked(getExpenses).mockRejectedValue(
      apiError("Splitwise", 401, { error: "Invalid API request: you are not logged in" }),
    );

    const { status, delivered } = await apiInvocation("GET", "/api/links/8/dry-run");

    expect(status).toBe(500);
    expect(sentryErrors(delivered)).toEqual([]);
    expect(sentryWarningFingerprints(delivered)).toEqual([
      ["sync-credential-rejected", "splitwise-access"],
    ]);
  });

  it("dry run returns its plan", async () => {
    await seedUserWithLink();
    vi.mocked(getExpenses).mockResolvedValue(noExpenses);

    const { status, body, delivered } = await apiInvocation("GET", "/api/links/1/dry-run");

    expect(body).toEqual({
      expenses_fetched: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      more_to_sync: false,
      actions: [],
      balance: { would_sync: false, balance: null, currency: null },
    });
    expect(status).toBe(200);
    expect(sentryErrors(delivered)).toEqual([]);
  });
});

describe("Dashboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rejectedKey = {
    linkId: 1,
    startedAt: "2026-10-23T12:00:00.000Z",
    finishedAt: "2026-10-23 12:00:05",
    status: "error",
    errorMessage: 'Lunch Money API error (401): {"message":"Unauthorized"}',
  };
  const keyRejectedFailure = {
    at: "2026-10-23T12:00:00.000Z",
    reason: "lunch-money-key",
    message: "Lunch Money no longer accepts your API key. Enter a new one under Connections.",
  };

  it("lists each link with its latest sync failure", async () => {
    const userDb = await seedUserWithLink({}, [rejectedKey]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await userDb.insert(userSchema.links).values({ id: 2, lmAccountId: 200 });

    const { status, body } = await apiInvocation("GET", "/api/links");

    expect(status).toBe(200);
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, lmAccountId: 100, lastFailure: keyRejectedFailure }),
        expect.objectContaining({ id: 2, lmAccountId: 200, lastFailure: null }),
      ]),
    );
  });

  it("says Lunch Money rejected the key until a new one is saved", async () => {
    await seedUserWithLink({}, [rejectedKey]);

    const before = await apiInvocation("GET", "/api/me");
    const saved = await apiInvocation("POST", "/api/settings/lunch-money", { apiKey: "new-key" });
    const after = await apiInvocation("GET", "/api/me");
    const linksAfter = await apiInvocation("GET", "/api/links");

    expect(before.body).toEqual({ hasLunchMoney: true, lunchMoneyKeyRejected: true });
    expect(saved.body).toEqual({ ok: true });
    expect(after.body).toEqual({ hasLunchMoney: true, lunchMoneyKeyRejected: false });
    expect(linksAfter.body).toEqual([expect.objectContaining({ id: 1, lastFailure: null })]);
  });

  it("adds one Turso request to each dashboard request", async () => {
    await seedUserWithLink({}, [rejectedKey]);
    markDbInitialized("libsql://user-7.example");
    const baseline = await apiInvocation("GET", "/api/links/1");

    const me = await apiInvocation("GET", "/api/me");
    const links = await apiInvocation("GET", "/api/links");

    expect(me.requests).toBe(baseline.requests);
    expect(links.requests).toBe(baseline.requests + 1);
  });

  it("records when logging in replaced the Splitwise token", async () => {
    const userDb = await seedUserWithLink();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const href = input instanceof Request ? input.url : String(input);
      if (href === "https://www.splitwise.com/oauth/token") {
        return Response.json({ access_token: "new-token" });
      }
      if (href.endsWith("/get_current_user")) return Response.json({ user: { id: 123 } });
      return new Response("{}");
    });
    const before = new Date().toISOString();

    const response = await worker.fetch!(
      new Request("https://lunchwise.example.com/auth/splitwise/callback?code=c&state=s", {
        headers: { cookie: "oauth_state=s" },
      }),
      workerEnv,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(302);
    const [cred] = await userDb.select().from(userSchema.credentials);
    expect(cred.splitwiseTokenUpdatedAt! >= before).toBe(true);
  });

  it("clears the production session cookie on logout", async () => {
    const response = await worker.fetch!(
      new Request("https://lunchwise.example.com/auth/logout", {
        headers: { cookie: "__Secure-lunchwise_session=token" },
      }),
      { ...workerEnv, NODE_ENV: "production" },
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toMatch(/^__Secure-lunchwise_session=;/u);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });
});

// Splitwise with this many expenses in each group, and a Lunch Money that takes whatever it's sent
// and holds this many transactions already
function fakeApis(
  expensesInGroup: Record<string, number>,
  transactionsInAccount = 0,
): typeof fetch {
  return async (input) => {
    if (!(input instanceof Request)) return new Response("{}");
    const url = new URL(input.url);
    if (url.pathname.endsWith("/get_expenses")) {
      const group = url.searchParams.get("group_id") ?? "";
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const count = Math.max(0, Math.min(limit, (expensesInGroup[group] ?? 0) - offset));
      return Response.json({
        expenses: Array.from({ length: count }, (_, i) => ({
          id: Number(group) * 100_000 + offset + i,
          description: "Dinner",
          cost: "20.00",
          currency_code: "USD",
          date: "2024-06-15T00:00:00Z",
          updated_at: "2024-06-15T12:00:00Z",
          deleted_at: null,
          payment: false,
          users: [{ user_id: 123, net_balance: "-10.00" }],
        })),
      });
    }
    if (url.pathname.includes("/get_group/")) {
      return Response.json({ group: { id: Number(url.pathname.split("/").pop()), members: [] } });
    }
    if (url.pathname === "/v2/transactions" && input.method === "POST") {
      const { transactions } = (await input.json()) as { transactions: { external_id: string }[] };
      return Response.json({
        transactions: transactions.map((tx) => ({
          id: Number(tx.external_id),
          external_id: tx.external_id,
        })),
      });
    }
    if (url.pathname === "/v2/transactions") {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const count = Math.max(0, Math.min(limit, transactionsInAccount - offset));
      return Response.json({
        transactions: Array.from({ length: count }, (_, i) => ({
          id: offset + i + 1,
          external_id: String(offset + i + 1),
          amount: "10.0000",
        })),
        has_more: offset + count < transactionsInAccount,
      });
    }
    if (url.pathname === "/v2/categories") return Response.json({ categories: [] });
    if (url.pathname === "/v2/me") return Response.json({ primary_currency: "usd" });
    return new Response("{}");
  };
}

describe("Large syncs", () => {
  const perRun = EXPENSE_PAGES_PER_RUN * EXPENSE_PAGE_SIZE;
  const catchingUp = { catchUpOffset: perRun, catchUpStartedAt: "2026-10-23T10:00:00.000Z" };

  beforeEach(() => {
    vi.mocked(getExpenses).mockImplementation(realGetExpenses);
    vi.mocked(getUser).mockImplementation(realGetUser);
    vi.mocked(getExchangeRates).mockResolvedValue({ USD: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stop a first sync's run short of the request warning and bookmark the rest", async () => {
    const userDb = await seedUserWithLink({ lastSyncedAt: null, syncBalance: 1 });

    const { message, delivered, requests } = await queueInvocation(
      realSyncUser,
      SYNC_QUEUE,
      { userId: 7, exchangeRates: { USD: 1 } },
      fakeApis({ 10: 10_000 }),
    );

    expect(message.ack).toHaveBeenCalled();
    expect(requests).toBeLessThanOrEqual(REQUEST_WARNING);
    expect(sentryErrors(delivered)).toEqual([]);
    expect(sentryWarningFingerprints(delivered)).toEqual([]);
    const [link] = await userDb.select().from(userSchema.links);
    expect(link).toMatchObject({ lastSyncedAt: null, catchUpOffset: perRun });
  });

  it("leave room for an ordinary link beside one that's catching up", async () => {
    const userDb = await seedUserWithLink({ lastSyncedAt: null, syncBalance: 1 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await userDb.insert(userSchema.links).values({
      splitwiseGroupId: "20",
      lmAccountId: 200,
      syncBalance: 1,
      lastSyncedAt: "2026-10-23T08:00:00.000Z",
    });

    const { message, delivered, requests } = await queueInvocation(
      realSyncUser,
      SYNC_QUEUE,
      { userId: 7, exchangeRates: { USD: 1 } },
      fakeApis({ 10: 10_000, 20: 5 }),
    );

    expect(message.ack).toHaveBeenCalled();
    expect(requests).toBeLessThan(REQUEST_BUDGET);
    expect(sentryErrors(delivered)).toEqual([]);
    const logs = await userDb.select().from(userSchema.syncLog);
    expect(logs.map((row) => [row.linkId, row.status, row.created])).toEqual([
      [1, "success", perRun],
      [2, "success", 5],
    ]);
  });

  it("Sync now runs the next part of a first sync and says more is to come", async () => {
    await seedUserWithLink({ id: 11, lastSyncedAt: null, syncBalance: 1 });

    const { status, body, requests, delivered } = await apiInvocation(
      "POST",
      "/api/sync/11",
      {},
      fakeApis({ 10: 10_000 }),
    );

    expect(status).toBe(200);
    expect(body).toEqual({ created: perRun, updated: 0, deleted: 0, more_to_sync: true });
    expect(requests).toBeLessThan(REQUEST_BUDGET);
    expect(sentryErrors(delivered)).toEqual([]);
  });

  it("dry run plans from the bookmark and says more is to come", async () => {
    await seedUserWithLink(catchingUp);
    vi.mocked(getExpenses).mockResolvedValue({ expenses: [], nextOffset: 2 * perRun });

    const { status, body } = await apiInvocation("GET", "/api/links/1/dry-run");

    expect(status).toBe(200);
    expect(body).toMatchObject({ expenses_fetched: 0, more_to_sync: true });
    expect(getExpenses).toHaveBeenCalledWith(
      "sw-token",
      expect.objectContaining({ offset: perRun - CATCH_UP_OVERLAP }),
    );
  });

  it("list whether each link is still catching up, and when it last synced", async () => {
    const userDb = await seedUserWithLink({ lastSyncedAt: null, ...catchingUp }, [
      { linkId: 1, startedAt: "2026-10-23T10:00:00.000Z", status: "success" },
      { linkId: 1, startedAt: "2026-10-23T12:00:00.000Z", status: "success" },
      { linkId: 1, startedAt: "2026-10-23T14:00:00.000Z", status: "running" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await userDb.insert(userSchema.links).values({ id: 2, lmAccountId: 200 });

    const { status, body } = await apiInvocation("GET", "/api/links");

    expect(status).toBe(200);
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 1,
          lastSyncedAt: null,
          lastSuccessAt: "2026-10-23T12:00:00.000Z",
          catchingUp: true,
        }),
        expect.objectContaining({ id: 2, lastSuccessAt: null, catchingUp: false }),
      ]),
    );
  });

  it.each([
    { edit: "changing the group", body: { splitwiseGroupId: "20" }, link: catchingUp, offset: 0 },
    {
      edit: "changing the start date",
      body: { startDate: "2024-01-01" },
      link: catchingUp,
      offset: 0,
    },
    { edit: "turning payments on", body: { includePayments: true }, link: catchingUp, offset: 0 },
    {
      edit: "turning payments off",
      body: { includePayments: false },
      link: { ...catchingUp, includePayments: 1 },
      offset: perRun,
    },
    {
      edit: "changing other settings",
      body: { lmAccountId: 200, syncBalance: true, enabled: false },
      link: catchingUp,
      offset: perRun,
    },
    {
      edit: "changing the group",
      body: { splitwiseGroupId: "20" },
      link: { catchUpOffset: null, catchUpStartedAt: null },
      offset: null,
    },
  ])(
    "$edit on a link with offset $link.catchUpOffset leaves it at $offset",
    async ({ body, link, offset }) => {
      const userDb = await seedUserWithLink({ lastSyncedAt: null, ...link });

      const { status } = await apiInvocation("PUT", "/api/links/1", {
        splitwiseGroupId: "10",
        lmAccountId: 100,
        startDate: null,
        enabled: true,
        ...body,
      });

      expect(status).toBe(200);
      const [row] = await userDb.select().from(userSchema.links);
      expect(row).toMatchObject({
        catchUpOffset: offset,
        catchUpStartedAt: link.catchUpStartedAt,
        lastSyncedAt: null,
      });
    },
  );
});

interface DatedExpense {
  id: number;
  date: string;
}

// `count` expenses numbered from `firstId`, dated an hour apart from `from`
function datedExpenses(firstId: number, count: number, from: string): DatedExpense[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    date: new Date(Date.parse(from) + i * 3_600_000).toISOString(),
  }));
}

// Splitwise listing each group's expenses updated since updated_after, newest date first (each was
// last updated on its date), and a Lunch Money that takes whatever it's sent
function fakeHistory(expensesInGroup: Record<string, DatedExpense[]>) {
  const requests: { method: string; url: URL; body: unknown }[] = [];
  const respond: typeof fetch = async (input) => {
    if (!(input instanceof Request)) return new Response("{}");
    const url = new URL(input.url);
    const body: unknown = input.method === "GET" ? null : await input.json();
    requests.push({ method: input.method, url, body });
    if (url.pathname.endsWith("/get_expenses")) {
      const updatedAfter = Date.parse(url.searchParams.get("updated_after") ?? "");
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const listing = (expensesInGroup[url.searchParams.get("group_id") ?? ""] ?? [])
        .filter((e) => Date.parse(e.date) > updatedAfter)
        .sort((a, b) => b.date.localeCompare(a.date));
      return Response.json({
        expenses: listing.slice(offset, offset + limit).map(({ id, date }) => ({
          id,
          description: "Dinner",
          cost: "20.00",
          currency_code: "USD",
          date,
          updated_at: date,
          deleted_at: null,
          payment: false,
          users: [{ user_id: 123, net_balance: "-10.00" }],
        })),
      });
    }
    if (url.pathname === "/v2/transactions" && input.method === "POST") {
      const { transactions } = body as { transactions: { external_id: string }[] };
      return Response.json({
        transactions: transactions.map((tx) => ({
          id: Number(tx.external_id),
          external_id: tx.external_id,
        })),
      });
    }
    if (url.pathname === "/v2/transactions" && input.method === "GET") {
      return Response.json({ transactions: [], has_more: false });
    }
    if (url.pathname === "/v2/categories") return Response.json({ categories: [] });
    return new Response("{}");
  };

  const lunchMoney = (method: string) =>
    requests.filter((r) => r.method === method && r.url.pathname === "/v2/transactions");
  const sent = (method: string) =>
    lunchMoney(method).flatMap(
      (r) => (r.body as { transactions: { id?: number; external_id?: string }[] }).transactions,
    );
  return {
    respond,
    created: () => sent("POST").map((tx) => Number(tx.external_id)),
    updated: () => sent("PUT").map((tx) => tx.id),
    backfills: () => lunchMoney("GET").length,
    fetchedSince: () =>
      requests
        .filter((r) => r.url.pathname.endsWith("/get_expenses"))
        .map((r) => r.url.searchParams.get("updated_after")),
  };
}

// Saves link 1 from the edit page, with group 10 from 2025 unless `changes` say otherwise.
function editLink(changes: Record<string, unknown>) {
  return apiInvocation("PUT", "/api/links/1", {
    splitwiseGroupId: "10",
    lmAccountId: 100,
    startDate: "2025-01-01",
    includePayments: false,
    syncBalance: false,
    enabled: true,
    ...changes,
  });
}

// Tracks these expenses on link 1, as if it had synced them.
async function trackSynced(userDb: UserDb, expenses: DatedExpense[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  await userDb.insert(userSchema.syncedTransactions).values(
    expenses.map(({ id, date }) => ({
      linkId: 1,
      splitwiseExpenseId: String(id),
      lmTransactionId: id,
      splitwiseUpdatedAt: date,
    })),
  );
}

describe("Widening a synced link", () => {
  const perRun = EXPENSE_PAGES_PER_RUN * EXPENSE_PAGE_SIZE;
  const editedAt = "2026-10-23T15:00:00.000Z";
  const syncedLink = { startDate: "2025-01-01", lastSyncedAt: "2026-10-01T00:00:00.000Z" };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(editedAt));
    vi.mocked(getExpenses).mockImplementation(realGetExpenses);
    vi.mocked(getUser).mockImplementation(realGetUser);
    vi.mocked(getExchangeRates).mockResolvedValue({ USD: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { edit: "changing the group", link: {}, changes: { splitwiseGroupId: "20" } },
    { edit: "changing to all groups", link: {}, changes: { splitwiseGroupId: null } },
    { edit: "changing from all groups", link: { splitwiseGroupId: null }, changes: {} },
    { edit: "moving the start date earlier", link: {}, changes: { startDate: "2020-01-23" } },
    { edit: "removing the start date", link: {}, changes: { startDate: null } },
    { edit: "turning payments on", link: {}, changes: { includePayments: true } },
    {
      edit: "moving the start date earlier during a catch-up",
      link: { catchUpOffset: perRun, catchUpStartedAt: "2026-10-23T10:00:00.000Z" },
      changes: { startDate: "2020-01-23" },
    },
  ])("$edit starts reading the link again from its start date", async ({ link, changes }) => {
    const userDb = await seedUserWithLink({ ...syncedLink, ...link });

    const { status } = await editLink(changes);

    expect(status).toBe(200);
    const [row] = await userDb.select().from(userSchema.links);
    expect(row).toMatchObject({ lastSyncedAt: null, catchUpOffset: 0, catchUpStartedAt: editedAt });
  });

  it.each([
    { edit: "moving the start date later", link: {}, changes: { startDate: "2026-01-01" } },
    { edit: "adding a start date", link: { startDate: null }, changes: {} },
    { edit: "turning payments off", link: { includePayments: 1 }, changes: {} },
    { edit: "changing the account", link: {}, changes: { lmAccountId: 200 } },
    { edit: "turning on balance sync", link: {}, changes: { syncBalance: true } },
    { edit: "disabling it", link: {}, changes: { enabled: false } },
    { edit: "saving it unchanged", link: {}, changes: {} },
  ])("$edit leaves the link's sync where it was", async ({ link, changes }) => {
    const userDb = await seedUserWithLink({ ...syncedLink, ...link });

    const { status } = await editLink(changes);

    expect(status).toBe(200);
    const [row] = await userDb.select().from(userSchema.links);
    expect(row).toMatchObject({
      lastSyncedAt: syncedLink.lastSyncedAt,
      catchUpOffset: null,
      catchUpStartedAt: null,
    });
  });

  it("brings in each expense an earlier start date covers once, and then syncs as usual", async () => {
    // synced from 2025, and 3,000 expenses from 2020 on that it has never read
    const recent = datedExpenses(1, 1500, "2025-01-02T00:00:00.000Z");
    const older = datedExpenses(5001, 3000, "2020-02-01T00:00:00.000Z");
    const fake = fakeHistory({ 10: [...recent, ...older] });
    const userDb = await seedUserWithLink(syncedLink);
    await trackSynced(userDb, recent);

    await editLink({ startDate: "2020-01-23" });
    const plan = await apiInvocation("GET", "/api/links/1/dry-run", undefined, fake.respond);
    const runs = [];
    for (const at of ["2026-10-23T16:00:00.000Z", "2026-10-23T18:00:00.000Z"]) {
      vi.setSystemTime(new Date(at));
      const { body } = await apiInvocation("POST", "/api/sync/1", undefined, fake.respond);
      runs.push(body);
    }

    const firstShare = perRun - recent.length;
    expect(plan.body).toMatchObject({
      expenses_fetched: perRun,
      created: firstShare,
      updated: 0,
      more_to_sync: true,
    });
    expect(runs).toEqual([
      { created: firstShare, updated: 0, deleted: 0, more_to_sync: true },
      { created: older.length - firstShare, updated: 0, deleted: 0, more_to_sync: false },
    ]);
    expect(fake.created().sort((a, b) => a - b)).toEqual(older.map((e) => e.id));
    expect(fake.updated()).toEqual([]);
    expect(fake.backfills()).toBe(0);
    const [link] = await userDb.select().from(userSchema.links);
    expect(link).toMatchObject({ lastSyncedAt: editedAt, catchUpOffset: null });

    vi.setSystemTime(new Date("2026-10-23T20:00:00.000Z"));
    await apiInvocation("POST", "/api/sync/1", undefined, fake.respond);
    expect(fake.fetchedSince().at(-1)).toBe("2026-10-23T14:58:00.000Z");
  });

  it("brings in a new group's expenses and leaves the old group's alone", async () => {
    const oldGroup = datedExpenses(1, 5, "2025-03-01T00:00:00.000Z");
    const newGroup = datedExpenses(101, 7, "2025-02-01T00:00:00.000Z");
    const fake = fakeHistory({ 10: oldGroup, 20: newGroup });
    const userDb = await seedUserWithLink(syncedLink);
    await trackSynced(userDb, oldGroup);

    await editLink({ splitwiseGroupId: "20" });
    const plan = await apiInvocation("GET", "/api/links/1/dry-run", undefined, fake.respond);
    vi.setSystemTime(new Date("2026-10-23T16:00:00.000Z"));
    const run = await apiInvocation("POST", "/api/sync/1", undefined, fake.respond);

    expect(plan.body).toMatchObject({ expenses_fetched: 7, created: 7, more_to_sync: false });
    expect(run.body).toEqual({ created: 7, updated: 0, deleted: 0, more_to_sync: false });
    expect(fake.created().sort((a, b) => a - b)).toEqual(newGroup.map((e) => e.id));
    expect(fake.updated()).toEqual([]);
    expect(fake.backfills()).toBe(0);
    const tracked = await userDb.select().from(userSchema.syncedTransactions);
    expect(
      tracked
        .filter((row) => !row.isDeleted)
        .map((row) => Number(row.splitwiseExpenseId))
        .sort((a, b) => a - b),
    ).toEqual([...oldGroup, ...newGroup].map((e) => e.id));
    const [link] = await userDb.select().from(userSchema.links);
    expect(link).toMatchObject({ lastSyncedAt: editedAt, catchUpOffset: null });
  });

  it("keeps the catch-up's runs on an account full of transactions under the request warning", async () => {
    const userDb = await seedUserWithLink({ ...syncedLink, syncBalance: 1 });
    await editLink({ splitwiseGroupId: "20", startDate: null, syncBalance: true });

    const { message, delivered, requests } = await queueInvocation(
      realSyncUser,
      SYNC_QUEUE,
      { userId: 7, exchangeRates: { USD: 1 } },
      fakeApis({ 20: 10_000 }, 10_000),
    );

    expect(message.ack).toHaveBeenCalled();
    expect(requests).toBeLessThanOrEqual(REQUEST_WARNING);
    expect(sentryErrors(delivered)).toEqual([]);
    expect(sentryWarningFingerprints(delivered)).toEqual([]);
    const [link] = await userDb.select().from(userSchema.links);
    expect(link).toMatchObject({ lastSyncedAt: null, catchUpOffset: perRun });
    const logs = await userDb.select().from(userSchema.syncLog);
    expect(logs.map((row) => [row.status, row.created])).toEqual([["success", perRun]]);
  });
});
