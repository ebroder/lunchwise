import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env, validateEnv } from "./env.js";

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string> = {
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
  // Clear env
  for (const key of Object.keys(env)) {
    delete env[key];
  }
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
}

describe("validateEnv", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    for (const key of Object.keys(env)) {
      delete env[key];
    }
  });

  it("passes silently when all required vars are present", () => {
    setEnv({ NODE_ENV: "production" });
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws in production when a required var is missing", () => {
    setEnv({ NODE_ENV: "production", TURSO_SHARED_DB_URL: undefined });
    expect(() => validateEnv()).toThrow("TURSO_SHARED_DB_URL is not set");
  });

  it("logs warnings in dev when a required var is missing", () => {
    setEnv({ NODE_ENV: "development", TURSO_SHARED_DB_URL: undefined });
    validateEnv();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("TURSO_SHARED_DB_URL is not set"));
  });

  it("throws when SESSION_SECRET is too short", () => {
    setEnv({ NODE_ENV: "production", SESSION_SECRET: "short" });
    expect(() => validateEnv()).toThrow("SESSION_SECRET must be at least 32 characters");
  });

  it("throws when ENCRYPTION_KEYS is not valid JSON", () => {
    setEnv({ NODE_ENV: "production", ENCRYPTION_KEYS: "not-json" });
    expect(() => validateEnv()).toThrow("ENCRYPTION_KEYS is not valid JSON");
  });

  it("throws when ENCRYPTION_KEYS is an empty object", () => {
    setEnv({ NODE_ENV: "production", ENCRYPTION_KEYS: "{}" });
    expect(() => validateEnv()).toThrow("at least one key");
  });
});
