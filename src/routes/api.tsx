import { Hono, type Context } from "hono";
import { eq, desc } from "drizzle-orm";
import { requireAuthJson, type AuthEnv } from "../lib/auth.js";
import { credentials, links, syncLog } from "../lib/schema-user.js";
import { syncLink, syncBalances, describeError } from "../lib/sync.js";
import { createSplitwiseClient, getGroups, getGroup, getUserBalances } from "../lib/splitwise.js";
import { createLunchMoneyClient, getManualAccounts, getUser } from "../lib/lunch-money.js";
import { getExchangeRates, convertCurrency } from "../lib/exchange-rates.js";
import { getSharedDb } from "../lib/db.js";
import { encrypt } from "../lib/crypto.js";
import { createLogger } from "../lib/logger.js";

const api = new Hono<AuthEnv>();

api.use("*", requireAuthJson);

api.use("*", async (c, next) => {
  const limiter = c.env.RATE_LIMITER;
  if (limiter) {
    const user = c.get("user");
    const { success } = await limiter.limit({ key: `user:${user.id}` });
    if (!success) {
      return c.json({ error: "Too many requests" }, 429);
    }
  }
  await next();
});

function parseLinkId(c: Context, param = "id") {
  const raw = c.req.param(param);
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

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
  const rows = await db.select().from(links).orderBy(desc(links.createdAt));
  return c.json(rows);
});

api.get("/links/:id", async (c) => {
  const linkId = parseLinkId(c);
  if (!linkId) return c.json({ error: "Invalid ID" }, 400);
  const db = c.get("db");
  const rows = await db.select().from(links).where(eq(links.id, linkId));
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
    syncBalance?: boolean;
  }>();

  const accountId = body.lmAccountId;
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return c.json({ error: "Invalid account ID" }, 400);
  }
  if (body.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
    return c.json({ error: "startDate must be YYYY-MM-DD" }, 400);
  }
  if (body.splitwiseGroupId && !/^\d+$/.test(body.splitwiseGroupId)) {
    return c.json({ error: "Invalid Splitwise group ID" }, 400);
  }

  const db = c.get("db");
  const [created] = await db
    .insert(links)
    .values({
      splitwiseGroupId: body.splitwiseGroupId || null,
      lmAccountId: accountId,
      startDate: body.startDate || null,
      includePayments: body.includePayments ? 1 : 0,
      syncBalance: body.syncBalance ? 1 : 0,
      enabled: 0,
    })
    .returning({ id: links.id });

  return c.json({ id: created.id });
});

api.put("/links/:id", async (c) => {
  const linkId = parseLinkId(c);
  if (!linkId) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    splitwiseGroupId?: string | null;
    lmAccountId: number;
    startDate?: string | null;
    includePayments?: boolean;
    syncBalance?: boolean;
    enabled?: boolean;
  }>();

  const accountId = body.lmAccountId;
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return c.json({ error: "Invalid account ID" }, 400);
  }
  if (body.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
    return c.json({ error: "startDate must be YYYY-MM-DD" }, 400);
  }
  if (body.splitwiseGroupId && !/^\d+$/.test(body.splitwiseGroupId)) {
    return c.json({ error: "Invalid Splitwise group ID" }, 400);
  }

  const db = c.get("db");
  const existing = await db.select({ id: links.id }).from(links).where(eq(links.id, linkId));
  if (!existing[0]) return c.json({ error: "Link not found" }, 404);

  await db
    .update(links)
    .set({
      splitwiseGroupId: body.splitwiseGroupId || null,
      lmAccountId: accountId,
      startDate: body.startDate || null,
      includePayments: body.includePayments ? 1 : 0,
      syncBalance: body.syncBalance ? 1 : 0,
      enabled: body.enabled ? 1 : 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(links.id, linkId));

  return c.json({ ok: true });
});

api.delete("/links/:id", async (c) => {
  const linkId = parseLinkId(c);
  if (!linkId) return c.json({ error: "Invalid ID" }, 400);
  const db = c.get("db");

  const existing = await db.select({ id: links.id }).from(links).where(eq(links.id, linkId));
  if (!existing[0]) return c.json({ error: "Link not found" }, 404);

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
  const linkId = parseLinkId(c);
  if (!linkId) return c.json({ error: "Invalid ID" }, 400);
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
  const linkId = parseLinkId(c);
  if (!linkId) return c.json({ error: "Invalid ID" }, 400);
  const db = c.get("db");

  const rows = await db.select().from(links).where(eq(links.id, linkId));
  const link = rows[0];
  if (!link) {
    return c.json({ error: "Link not found" }, 404);
  }

  try {
    const result = await syncLink(db, link, user, { dryRun: true });

    // Compute projected balance if balance sync is enabled
    let balancePreview: {
      would_sync: boolean;
      balance: number | null;
      currency: string | null;
      balances_by_currency?: { currency: string; amount: number }[];
    } = { would_sync: false, balance: null, currency: null };

    if (link.syncBalance === 1 && user.lunchMoneyApiKey) {
      try {
        const [lmUser, rates] = await Promise.all([
          getUser(user.lunchMoneyApiKey),
          getExchangeRates(getSharedDb()),
        ]);
        const targetCurrency = lmUser.primary_currency.toUpperCase();

        const groups = link.splitwiseGroupId
          ? [await getGroup(user.splitwiseAccessToken, parseInt(link.splitwiseGroupId, 10))]
          : await getGroups(user.splitwiseAccessToken);

        const rawBalances: { currency: string; amount: number }[] = [];
        let total = 0;
        for (const group of groups) {
          if (!group) continue;
          for (const { currency, amount } of getUserBalances(group, user.splitwiseUserId)) {
            rawBalances.push({ currency, amount });
            total += convertCurrency(amount, currency, targetCurrency, rates);
          }
        }

        balancePreview = {
          would_sync: true,
          balance: Math.round(total * 10000) / 10000,
          currency: targetCurrency,
          balances_by_currency: rawBalances,
        };
      } catch (err) {
        const log = createLogger({ source: "api", endpoint: "dry-run", linkId });
        log.warn("Balance preview failed", { error: describeError(err) });
      }
    }

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
      balance: balancePreview,
    });
  } catch (err) {
    const log = createLogger({ source: "api", endpoint: "dry-run", linkId });
    log.error("Dry run failed", { error: describeError(err) });
    return c.json({ error: "Dry run failed" }, 500);
  }
});

// --- Sync ---

api.post("/sync/:linkId", async (c) => {
  const user = c.get("user");
  const linkId = parseLinkId(c, "linkId");
  if (!linkId) return c.json({ error: "Invalid ID" }, 400);
  const db = c.get("db");

  const rows = await db.select().from(links).where(eq(links.id, linkId));
  const link = rows[0];
  if (!link) {
    return c.json({ error: "Link not found" }, 404);
  }

  try {
    const result = await syncLink(db, link, user);

    // Balance sync for this link (failures are logged but don't fail the response)
    if (link.syncBalance === 1 && user.lunchMoneyApiKey) {
      try {
        const rates = await getExchangeRates(getSharedDb());
        const balanceLog = createLogger({ source: "api", endpoint: "sync", linkId });
        await syncBalances([link], user, rates, balanceLog);
      } catch (err) {
        const balanceLog = createLogger({ source: "api", endpoint: "sync", linkId });
        balanceLog.warn("Balance sync failed during manual sync", { error: describeError(err) });
      }
    }

    return c.json({
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
    });
  } catch (err) {
    const log = createLogger({ source: "api", endpoint: "sync", linkId });
    log.error("Sync failed", { error: describeError(err) });
    return c.json({ error: "Sync failed" }, 500);
  }
});

export { api };
