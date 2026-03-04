import { SignJWT, jwtVerify } from "jose";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { getSharedDb, getUserDb, initUserDb, type UserDb } from "./db.js";
import { users } from "./schema-shared.js";
import { credentials } from "./schema-user.js";
import { env } from "./env.js";
import { decrypt } from "./crypto.js";

const COOKIE_NAME = "lunchwise_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function getSecret(): Uint8Array {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  if (secret.length < 32)
    throw new Error("SESSION_SECRET must be at least 32 characters");
  return new TextEncoder().encode(secret);
}

export async function createSession(
  c: Context,
  userId: number,
): Promise<void> {
  const token = await new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function getUserId(c: Context): Promise<number | null> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
    });
    return payload.sub ? parseInt(payload.sub, 10) : null;
  } catch {
    return null;
  }
}

export interface User {
  id: number;
  splitwiseUserId: string;
  tursoDbUrl: string;
  splitwiseAccessToken: string;
  lunchMoneyApiKey: string | null;
}

export type AuthEnv = {
  Bindings: {
    RATE_LIMITER?: RateLimit;
  };
  Variables: {
    user: User;
    db: UserDb;
  };
};

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

const initializedDbs = new Set<string>();

async function resolveAuth(c: Context): Promise<{ user: User; db: UserDb } | null> {
  const userId = await getUserId(c);
  if (!userId) return null;

  const shared = getSharedDb();
  const rows = await shared
    .select()
    .from(users)
    .where(eq(users.id, userId));
  const row = rows[0];
  if (!row?.tursoDbUrl) return null;

  const userDb = getUserDb(row.tursoDbUrl);
  if (!initializedDbs.has(row.tursoDbUrl)) {
    await initUserDb(userDb);
    initializedDbs.add(row.tursoDbUrl);
  }

  const creds = await userDb.select().from(credentials).limit(1);
  const cred = creds[0];
  if (!cred) return null;

  return {
    user: {
      id: row.id,
      splitwiseUserId: row.splitwiseUserId,
      tursoDbUrl: row.tursoDbUrl,
      splitwiseAccessToken: await decrypt(cred.splitwiseAccessToken),
      lunchMoneyApiKey: cred.lunchMoneyApiKey
        ? await decrypt(cred.lunchMoneyApiKey)
        : null,
    },
    db: userDb,
  };
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const result = await resolveAuth(c);
  if (!result) return c.redirect("/");
  c.set("user", result.user);
  c.set("db", result.db);
  await next();
});

export const requireAuthJson = createMiddleware<AuthEnv>(async (c, next) => {
  const result = await resolveAuth(c);
  if (!result) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", result.user);
  c.set("db", result.db);
  await next();
});
