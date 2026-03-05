import { env } from "./env.js";

const IV_BYTES = 12;
const KEY_PREFIX_RE = /^(\d+):/;

let keyCache: Map<string, CryptoKey> | null = null;
let activeKeyId: string | null = null;

/** Clear cached keys so they're re-derived from env on next use. */
export function resetKeyCache(): void {
  keyCache = null;
  activeKeyId = null;
}

function parseKeys(): Record<string, string> {
  const raw = env.ENCRYPTION_KEYS;
  if (!raw) throw new Error("ENCRYPTION_KEYS secret is not set");
  return JSON.parse(raw) as Record<string, string>;
}

async function getKeys(): Promise<Map<string, CryptoKey>> {
  if (keyCache) return keyCache;

  const parsed = parseKeys();
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("ENCRYPTION_KEYS is empty");

  const map = new Map<string, CryptoKey>();
  for (const [id, b64] of entries) {
    const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    map.set(id, key);
  }

  // Active key = highest numeric ID
  activeKeyId = entries
    .map(([id]) => id)
    .sort((a, b) => Number(a) - Number(b))
    .at(-1)!;

  keyCache = map;
  return map;
}

export async function encrypt(plaintext: string): Promise<string> {
  const keys = await getKeys();
  const key = keys.get(activeKeyId!);
  if (!key) throw new Error(`Active encryption key "${activeKeyId}" not found`);

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  // Combine IV + ciphertext (which includes the auth tag)
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(cipherBuf), iv.length);

  let binary = "";
  for (let i = 0; i < combined.length; i++) {
    binary += String.fromCharCode(combined[i]);
  }
  return `${activeKeyId}:${btoa(binary)}`;
}

export async function decrypt(value: string): Promise<string> {
  const match = value.match(KEY_PREFIX_RE);
  if (!match) {
    throw new Error(
      "crypto.decrypt: value has no key ID prefix (expected format '<keyId>:<base64>')",
    );
  }

  const keyId = match[1];
  const keys = await getKeys();
  const key = keys.get(keyId);
  if (!key) throw new Error(`Encryption key "${keyId}" not found`);

  const payload = value.slice(match[0].length);
  const combined = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));

  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);

  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);

  return new TextDecoder().decode(plainBuf);
}
