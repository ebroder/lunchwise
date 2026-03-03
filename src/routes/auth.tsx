import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { OAuth2Client, generateState } from "arctic";
import { eq } from "drizzle-orm";
import { createSession, clearSession } from "../lib/auth.js";
import { getSharedDb, getUserDb, initUserDb } from "../lib/db.js";
import { users } from "../lib/schema-shared.js";
import { credentials } from "../lib/schema-user.js";
import { createSplitwiseClient } from "../lib/splitwise.js";
import { createTursoDatabase } from "../lib/turso.js";

const auth = new Hono();

function getOAuthClient(): OAuth2Client {
  const clientId = process.env.SPLITWISE_CLIENT_ID;
  const clientSecret = process.env.SPLITWISE_CLIENT_SECRET;
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  if (!clientId || !clientSecret) {
    throw new Error("SPLITWISE_CLIENT_ID and SPLITWISE_CLIENT_SECRET required");
  }
  return new OAuth2Client(
    clientId,
    clientSecret,
    `${appUrl}/auth/splitwise/callback`,
  );
}

const AUTHORIZE_URL = "https://www.splitwise.com/oauth/authorize";
const TOKEN_URL = "https://www.splitwise.com/oauth/token";

auth.get("/splitwise", (c) => {
  const client = getOAuthClient();
  const state = generateState();
  const url = client.createAuthorizationURL(AUTHORIZE_URL, state, []);

  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 10,
  });

  return c.redirect(url.toString());
});

auth.get("/splitwise/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, "oauth_state");

  if (!code || !state || state !== storedState) {
    return c.text("Invalid OAuth callback", 400);
  }

  deleteCookie(c, "oauth_state", { path: "/" });

  const client = getOAuthClient();
  const tokens = await client.validateAuthorizationCode(
    TOKEN_URL,
    code,
    null,
  );
  const accessToken = tokens.accessToken();

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
      splitwiseAccessToken: accessToken,
    });
  } else {
    // Returning user: update access token in per-user DB
    const userDb = getUserDb(tursoDbUrl);
    await userDb
      .update(credentials)
      .set({
        splitwiseAccessToken: accessToken,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(credentials.id, 1));
  }

  await createSession(c, userId);
  return c.redirect("/dashboard");
});

auth.get("/logout", (c) => {
  clearSession(c);
  return c.redirect("/");
});

export { auth };
