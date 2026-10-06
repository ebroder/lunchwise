import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "./index.js";

vi.mock("./app.js", () => ({
  app: {
    fetch: async () => {
      throw new Error("handler failed");
    },
  },
}));

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
});
