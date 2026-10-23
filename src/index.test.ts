import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "./index.js";
import { syncAllEnabled } from "./lib/sync.js";

vi.mock("./app.js", () => ({
  app: {
    fetch: async () => {
      throw new Error("handler failed");
    },
  },
}));

vi.mock("./lib/sync.js", () => ({ syncAllEnabled: vi.fn() }));

const SENTRY_HOST = "sentry.example.com";

const workerEnv: Record<string, string> = {
  SENTRY_DSN: `https://public@${SENTRY_HOST}/1`,
  SESSION_SECRET: "a".repeat(32),
  TURSO_SHARED_DB_URL: "libsql://test.turso.io",
  TURSO_AUTH_TOKEN: "token",
  SPLITWISE_CLIENT_ID: "client-id",
  SPLITWISE_CLIENT_SECRET: "client-secret",
  APP_URL: "https://example.com",
  ENCRYPTION_KEYS: JSON.stringify({ "1": "dGVzdGtleXRlc3RrZXkxMjM0NTY3ODk=" }),
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
async function cronCheckIns(
  syncOutcome: "ok" | "error",
): Promise<{ duringSync: string[]; delivered: string[] }> {
  let invocationEnded = false;
  const delivered: string[] = [];
  const decoder = new TextDecoder();
  const statuses = () =>
    delivered
      .flatMap((envelope) => envelope.split("\n"))
      .flatMap((line) => {
        try {
          const item = JSON.parse(line) as { monitor_slug?: string; status?: string };
          return item.monitor_slug === "lunchwise-sync" && item.status ? [item.status] : [];
        } catch {
          return [];
        }
      });
  let duringSync: string[] = [];
  vi.mocked(syncAllEnabled).mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          duringSync = statuses();
          if (syncOutcome === "ok") resolve();
          else reject(new Error("sync failed"));
        }, 200);
      }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
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
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const controller = {
    cron: "0 */2 * * *",
    scheduledTime: Date.now(),
    noRetry: () => {},
  } as ScheduledController;

  pending.push(Promise.resolve(worker.scheduled?.(controller, workerEnv, ctx)));
  for (let settled = 0; settled < pending.length; ) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.allSettled(batch);
    await new Promise((r) => {
      setTimeout(r, 0);
    });
  }
  invocationEnded = true;

  return { duringSync, delivered: statuses() };
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
});
