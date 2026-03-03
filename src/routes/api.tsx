import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthEnv } from "../lib/auth.js";
import { credentials, links, syncLog } from "../lib/schema-user.js";
import { syncLink } from "../lib/sync.js";
import { createSplitwiseClient } from "../lib/splitwise.js";
import { createLunchMoneyClient, getManualAccounts } from "../lib/lunch-money.js";
import { encrypt } from "../lib/crypto.js";

const api = new Hono<AuthEnv>();

api.use("*", requireAuth);

// Save and validate Lunch Money API key
api.post("/settings/lunch-money", async (c) => {
  const body = await c.req.parseBody();
  const db = c.get("db");

  if (body._method === "DELETE") {
    // Only allow clearing the token when no links exist
    const existingLinks = await db.select().from(links).limit(1);
    if (existingLinks.length > 0) {
      return c.redirect("/dashboard");
    }
    await db
      .update(credentials)
      .set({ lunchMoneyApiKey: null, updatedAt: new Date().toISOString() })
      .where(eq(credentials.id, 1));
    return c.redirect("/dashboard");
  }

  const apiKey = String(body.api_key || "").trim();

  if (!apiKey) {
    return c.redirect("/dashboard?error=missing_key");
  }

  // Validate by calling Lunch Money
  const client = createLunchMoneyClient(apiKey);
  const { error } = await client.GET("/me");
  if (error) {
    return c.redirect("/dashboard?error=invalid_key");
  }

  await db
    .update(credentials)
    .set({
      lunchMoneyApiKey: await encrypt(apiKey),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(credentials.id, 1));

  return c.redirect("/dashboard");
});

// Proxy: Splitwise groups
api.get("/splitwise/groups", async (c) => {
  const user = c.get("user");
  const sw = createSplitwiseClient(user.splitwiseAccessToken);
  const { data, error } = await sw.GET("/get_groups");

  if (error) {
    return c.json({ error: "Failed to fetch groups" }, 500);
  }

  return c.json(data?.groups ?? []);
});

// Proxy: Lunch Money manual accounts
api.get("/lunch-money/accounts", async (c) => {
  const user = c.get("user");
  if (!user.lunchMoneyApiKey) {
    return c.json({ error: "Lunch Money not connected" }, 400);
  }

  try {
    const accounts = await getManualAccounts(user.lunchMoneyApiKey);
    return c.json(accounts);
  } catch {
    return c.json({ error: "Failed to fetch accounts" }, 500);
  }
});

// Create link
api.post("/links", async (c) => {
  const body = await c.req.parseBody();

  const groupId = body.splitwise_group_id
    ? String(body.splitwise_group_id)
    : null;
  const accountId = parseInt(String(body.lm_account_id), 10);
  const startDate = body.start_date ? String(body.start_date) : null;
  const includePayments = body.include_payments === "on" ? 1 : 0;

  if (!Number.isInteger(accountId) || accountId <= 0) {
    return c.redirect("/dashboard/links/new?error=missing_account");
  }

  const db = c.get("db");
  const [created] = await db
    .insert(links)
    .values({
      splitwiseGroupId: groupId,
      lmAccountId: accountId,
      startDate,
      includePayments,
      enabled: 0,
    })
    .returning({ id: links.id });

  return c.redirect(`/dashboard/links/${created.id}`);
});

// Update or delete link
api.post("/links/:id", async (c) => {
  const linkId = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody();
  const db = c.get("db");

  if (body._method === "DELETE") {
    const client = db.$client;
    await client.batch([
      {
        sql: "DELETE FROM synced_transactions WHERE link_id = ?",
        args: [linkId],
      },
      {
        sql: "DELETE FROM sync_log WHERE link_id = ?",
        args: [linkId],
      },
      {
        sql: "DELETE FROM links WHERE id = ?",
        args: [linkId],
      },
    ]);
    return c.redirect("/dashboard");
  }

  const groupId = body.splitwise_group_id
    ? String(body.splitwise_group_id)
    : null;
  const accountId = parseInt(String(body.lm_account_id), 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return c.redirect(`/dashboard/links/${linkId}?error=invalid_account`);
  }
  const startDate = body.start_date ? String(body.start_date) : null;
  const includePayments = body.include_payments === "on" ? 1 : 0;
  const enabled = body.enabled === "on" ? 1 : 0;

  await db
    .update(links)
    .set({
      splitwiseGroupId: groupId,
      lmAccountId: accountId,
      startDate,
      includePayments,
      enabled,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(links.id, linkId));

  return c.redirect("/dashboard");
});

// Manual sync trigger
api.post("/sync/:linkId", async (c) => {
  const user = c.get("user");
  const linkId = parseInt(c.req.param("linkId"), 10);
  const db = c.get("db");

  const rows = await db
    .select()
    .from(links)
    .where(eq(links.id, linkId));
  const link = rows[0];
  if (!link) {
    return c.redirect("/dashboard");
  }

  try {
    const result = await syncLink(db, link, user);
    return c.redirect(
      `/dashboard?synced=${linkId}&created=${result.created}&updated=${result.updated}&deleted=${result.deleted}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.redirect(
      `/dashboard?sync_error=${linkId}&message=${encodeURIComponent(message)}`,
    );
  }
});

export { api };
