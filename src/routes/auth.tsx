import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { createSession, clearSession } from "../lib/auth.js";
import { getSharedDb, getUserDb, initUserDb } from "../lib/db.js";
import { users } from "../lib/schema-shared.js";
import { credentials } from "../lib/schema-user.js";
import { createSplitwiseClient } from "../lib/splitwise.js";
import { createTursoDatabase } from "../lib/turso.js";
import { env } from "../lib/env.js";
import { encrypt } from "../lib/crypto.js";

const auth = new Hono();

const AUTHORIZE_URL = "https://www.splitwise.com/oauth/authorize";
const TOKEN_URL = "https://www.splitwise.com/oauth/token";

auth.get("/splitwise", (c) => {
  const appUrl = env.APP_URL || "http://localhost:3000";
  const state = crypto.randomUUID();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.SPLITWISE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${appUrl}/auth/splitwise/callback`);
  url.searchParams.set("state", state);

  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 10,
  });

  return c.redirect(url.toString());
});

auth.get("/splitwise/callback", async (c) => {
  try {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const storedState = getCookie(c, "oauth_state");

    if (!code || !state || state !== storedState) {
      return c.text("Invalid OAuth callback", 400);
    }

    deleteCookie(c, "oauth_state", { path: "/" });

    const appUrl = env.APP_URL || "http://localhost:3000";
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${appUrl}/auth/splitwise/callback`,
        client_id: env.SPLITWISE_CLIENT_ID!,
        client_secret: env.SPLITWISE_CLIENT_SECRET!,
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Splitwise token exchange failed (${tokenRes.status}): ${body}`);
    }
    const tokenData: { access_token: string } = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch the current Splitwise user
    const sw = createSplitwiseClient(accessToken);
    const { data, error } = await sw.GET("/get_current_user");
    if (error || !data?.user?.id) {
      return c.text("Failed to fetch Splitwise user", 500);
    }

    const splitwiseUserId = String(data.user.id);
    const shared = getSharedDb();

    // Upsert user in shared DB (no credentials here)
    const result = await shared
      .insert(users)
      .values({ splitwiseUserId })
      .onConflictDoUpdate({
        target: users.splitwiseUserId,
        set: { updatedAt: new Date().toISOString() },
      })
      .returning({ id: users.id, tursoDbUrl: users.tursoDbUrl });

    const { id: userId, tursoDbUrl } = result[0];

    if (!tursoDbUrl) {
      // New user: create per-user database
      const dbName = `lunchwise-user-${splitwiseUserId}`;
      const newDbUrl = await createTursoDatabase(dbName);

      await shared
        .update(users)
        .set({ tursoDbUrl: newDbUrl, updatedAt: new Date().toISOString() })
        .where(eq(users.id, userId));

      const userDb = getUserDb(newDbUrl);
      await initUserDb(userDb);

      await userDb.insert(credentials).values({
        splitwiseAccessToken: await encrypt(accessToken),
      });
    } else {
      // Returning user: update access token in per-user DB
      const userDb = getUserDb(tursoDbUrl);
      await userDb
        .update(credentials)
        .set({
          splitwiseAccessToken: await encrypt(accessToken),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(credentials.id, 1));
    }

    await createSession(c, userId);
    return c.redirect("/dashboard");
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return c.text("Internal server error", 500);
  }
});

auth.get("/logout", (c) => {
  clearSession(c);
  return c.redirect("/");
});

export { auth };
