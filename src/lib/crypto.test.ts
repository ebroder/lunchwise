import { describe, it, expect, beforeEach } from "vitest";
import { env } from "./env.js";
import { encrypt, decrypt } from "./crypto.js";

// Generate a deterministic 32-byte test key (base64-encoded)
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xab)));

beforeEach(() => {
  env.ENCRYPTION_KEYS = JSON.stringify({ "1": TEST_KEY });
});

describe("encrypt + decrypt", () => {
  it("round-trips plaintext", async () => {
    const plaintext = "hello world";
    const encrypted = await encrypt(plaintext);
    const decrypted = await decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("output has key ID prefix format", async () => {
    const encrypted = await encrypt("test");
    expect(encrypted).toMatch(/^\d+:/);
    const [keyId, payload] = encrypted.split(":", 2);
    expect(keyId).toBe("1");
    expect(payload.length).toBeGreaterThan(0);
  });

  it("different plaintexts produce different ciphertexts (random IV)", async () => {
    const a = await encrypt("same text");
    const b = await encrypt("same text");
    expect(a).not.toBe(b);
  });
});

describe("decrypt error cases", () => {
  it("throws on missing key prefix", async () => {
    await expect(decrypt("no-prefix-here")).rejects.toThrow("no key ID prefix");
  });

  it("throws on unknown key ID", async () => {
    const encrypted = await encrypt("test");
    // Replace key ID "1:" with "99:"
    const tampered = encrypted.replace(/^\d+:/, "99:");
    await expect(decrypt(tampered)).rejects.toThrow('Encryption key "99" not found');
  });
});
