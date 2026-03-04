import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { requireAuthJson, type AuthEnv } from "../lib/auth.js";
import { credentials, links, syncLog } from "../lib/schema-user.js";
import { syncLink, describeError } from "../lib/sync.js";
import { createSplitwiseClient } from "../lib/splitwise.js";
import { createLunchMoneyClient, getManualAccounts } from "../lib/lunch-money.js";
import { encrypt } from "../lib/crypto.js";
import { createLogger } from "../lib/logger.js";

const api = new Hono<AuthEnv>();

api.use("*", requireAuthJson);

// --- User ---

api.get("/me", async (c) => {
  const user = c.get("user");
  return c.json({ hasLunchMoney: !!user.lunchMoneyApiKey });
});

// --- Settings ---

api.post("/settings/lunch-money", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{ apiKey: string }>();
  const apiKey = (body.apiKey || "").trim();

  if (!apiKey) {
    return c.json({ error: "API key is required" }, 400);
  }

  const client = createLunchMoneyClient(apiKey);
  const { error } = await client.GET("/me");
  if (error) {
    return c.json({ error: "Invalid API key" }, 400);
  }

  await db
    .update(credentials)
    .set({
      lunchMoneyApiKey: await encrypt(apiKey),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(credentials.id, 1));

  return c.json({ ok: true });
});

api.delete("/settings/lunch-money", async (c) => {
  const db = c.get("db");
  const existingLinks = await db.select().from(links).limit(1);
  if (existingLinks.length > 0) {
    return c.json({ error: "Remove all links before disconnecting" }, 400);
  }

  await db
    .update(credentials)
    .set({ lunchMoneyApiKey: null, updatedAt: new Date().toISOString() })
    .where(eq(credentials.id, 1));

  return c.json({ ok: true });
});

// --- Proxies ---

api.get("/splitwise/groups", async (c) => {
  const user = c.get("user");
  const sw = createSplitwiseClient(user.splitwiseAccessToken);
  const { data, error } = await sw.GET("/get_groups");

  if (error) {
    const log = createLogger({ source: "api", endpoint: "splitwise/groups" });
    log.error("Failed to fetch Splitwise groups", { error });
    return c.json({ error: "Failed to fetch groups" }, 500);
  }

  return c.json(data?.groups ?? []);
});

api.get("/lunch-money/accounts", async (c) => {
  const user = c.get("user");
  if (!user.lunchMoneyApiKey) {
    return c.json({ error: "Lunch Money not connected" }, 400);
  }

  try {
    const accounts = await getManualAccounts(user.lunchMoneyApiKey);
    return c.json(accounts);
  } catch (err) {
    const log = createLogger({ source: "api", endpoint: "lunch-money/accounts" });
    log.error("Failed to fetch LM accounts", { error: describeError(err) });
    return c.json({ error: "Failed to fetch accounts" }, 500);
  }
});

// --- Links ---

api.get("/links", async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(links)
    .orderBy(desc(links.createdAt));
  return c.json(rows);
});

api.get("/links/:id", async (c) => {
  const linkId = parseInt(c.req.param("id"), 10);
  const db = c.get("db");
  const rows = await db
    .select()
    .from(links)
    .where(eq(links.id, linkId));
  const link = rows[0];
  if (!link) {
    return c.json({ error: "Link not found" }, 404);
  }
  return c.json(link);
});

api.post("/links", async (c) => {
  const body = await c.req.json<{
    splitwiseGroupId?: string | null;
    lmAccountId: number;
    startDate?: string | null;
    includePayments?: boolean;
  }>();

  const accountId = body.lmAccountId;
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return c.json({ error: "Invalid account ID" }, 400);
  }

  const db = c.get("db");
  const [created] = await db
    .insert(links)
    .values({
      splitwiseGroupId: body.splitwiseGroupId || null,
      lmAccountId: accountId,
      startDate: body.startDate || null,
      includePayments: body.includePayments ? 1 : 0,
      enabled: 0,
    })
    .returning({ id: links.id });

  return c.json({ id: created.id });
});

api.put("/links/:id", async (c) => {
  const linkId = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{
    splitwiseGroupId?: string | null;
    lmAccountId: number;
    startDate?: string | null;
    includePayments?: boolean;
    enabled?: boolean;
  }>();

  const accountId = body.lmAccountId;
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return c.json({ error: "Invalid account ID" }, 400);
  }

  const db = c.get("db");
  await db
    .update(links)
    .set({
      splitwiseGroupId: body.splitwiseGroupId || null,
      lmAccountId: accountId,
      startDate: body.startDate || null,
      includePayments: body.includePayments ? 1 : 0,
      enabled: body.enabled ? 1 : 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(links.id, linkId));

  return c.json({ ok: true });
});

api.delete("/links/:id", async (c) => {
  const linkId = parseInt(c.req.param("id"), 10);
  const db = c.get("db");
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
  return c.json({ ok: true });
});

// --- History ---

api.get("/links/:id/history", async (c) => {
  const linkId = parseInt(c.req.param("id"), 10);
  const db = c.get("db");
  const logs = await db
    .select()
    .from(syncLog)
    .where(eq(syncLog.linkId, linkId))
    .orderBy(desc(syncLog.startedAt))
    .limit(50);
  return c.json(logs);
});

// --- Dry Run ---

api.get("/links/:id/dry-run", async (c) => {
  const user = c.get("user");
  const linkId = parseInt(c.req.param("id"), 10);
  const db = c.get("db");

  const rows = await db
    .select()
    .from(links)
    .where(eq(links.id, linkId));
  const link = rows[0];
  if (!link) {
    return c.json({ error: "Link not found" }, 404);
  }

  try {
    const result = await syncLink(db, link, user, { dryRun: true });
    return c.json({
      expenses_fetched: result.expenses_fetched,
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      actions: (result.actions ?? []).map((a) => ({
        type: a.type,
        date: a.date,
        payee: a.payee,
        amount: a.amount,
        currency: a.currency,
        expenseId: a.expenseId,
      })),
    });
  } catch (err) {
    const message = describeError(err);
    const log = createLogger({ source: "api", endpoint: "dry-run", linkId });
    log.error("Dry run failed", { error: message });
    return c.json({ error: message }, 500);
  }
});

// --- Sync ---

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
    return c.json({ error: "Link not found" }, 404);
  }

  try {
    const result = await syncLink(db, link, user);
    return c.json({
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
    });
  } catch (err) {
    const message = describeError(err);
    const log = createLogger({ source: "api", endpoint: "sync", linkId });
    log.error("Sync failed", { error: message });
    return c.json({ error: message }, 500);
  }
});

export { api };
