import { eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getSharedDb, getUserDb, initUserDb, type UserDb } from "./db.js";
import { users } from "./schema-shared.js";
import { credentials, links, syncedTransactions, syncLog } from "./schema-user.js";
import {
  getAllExpenses,
  getUserShare,
  getGroups,
  getGroup,
  getUserBalances,
  type SplitwiseExpense,
} from "./splitwise.js";
import {
  insertTransactions,
  updateTransactions,
  getTransactions,
  getUser,
  updateAccountBalance,
  type LmInsertTransaction,
} from "./lunch-money.js";
import {
  getExchangeRates,
  convertCurrency,
  type ExchangeRates,
} from "./exchange-rates.js";
import type { User } from "./auth.js";
import { decrypt } from "./crypto.js";
import { createLogger } from "./logger.js";

type Link = typeof links.$inferSelect;

/** Extract a useful error message, including libsql error codes when available. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as unknown as Record<string, unknown>;
  const parts: string[] = [];
  // Error class name (e.g. LibsqlError vs Error)
  if (err.constructor.name !== "Error") parts.push(`[${err.constructor.name}]`);
  if (e.code) parts.push(`code=${e.code}`);
  if (e.rawCode !== undefined) parts.push(`rawCode=${e.rawCode}`);
  parts.push(err.message);
  // Check for a wrapped cause
  if (err.cause instanceof Error) {
    parts.push(`| cause: ${describeError(err.cause)}`);
  }
  return parts.join(" ");
}
type TrackedRow = typeof syncedTransactions.$inferSelect;

export interface PlannedAction {
  type: "create" | "update" | "delete";
  expenseId: string;
  date: string;
  payee: string;
  amount: number;
  currency: string;
  splitwiseUpdatedAt: string;
  lmData: {
    date: string;
    amount: number;
    payee: string;
    currency: LmInsertTransaction["currency"];
    manual_account_id: number;
    external_id: string;
    notes: string;
    status: "unreviewed" | "reviewed";
  };
  // Present for update/delete (the existing LM transaction to modify)
  tracked?: TrackedRow;
}

export interface SyncResult {
  expenses_fetched: number;
  created: number;
  updated: number;
  deleted: number;
  actions?: PlannedAction[];
}

interface SyncOptions {
  dryRun?: boolean;
}

function buildNotes(expense: SplitwiseExpense, userAmount: number): string {
  const parts: string[] = [];
  if (expense.category?.name) parts.push(expense.category.name);
  const total = parseFloat(expense.cost ?? "0");
  if (total !== Math.abs(userAmount)) {
    parts.push(`Total: ${expense.currency_code} ${expense.cost}`);
  }
  return parts.join(" | ").slice(0, 350);
}

// Build a map of tracked expenses. For first sync, either runs real backfill
// (mutates DB) or simulates it (in-memory only). Also returns LM amounts
// for backfilled rows so planSync can compare against Splitwise.
async function buildTrackedMap(
  db: UserDb,
  link: Link,
  apiKey: string,
  dryRun: boolean,
  log: ReturnType<typeof createLogger>,
): Promise<{
  tracked: Map<string, TrackedRow>;
  backfilledAmounts: Map<string, number>;
}> {
  const tracked = new Map<string, TrackedRow>();
  const backfilledAmounts = new Map<string, number>();

  if (!link.lastSyncedAt) {
    // Fetch existing LM transactions once (used for both backfill and amount comparison)
    const lmTransactions = await getTransactions(apiKey, {
      manual_account_id: link.lmAccountId,
      start_date: link.startDate ?? "2000-01-01",
      end_date: "2099-12-31",
    });

    const backfillRows = [];
    for (const tx of lmTransactions) {
      if (!tx.external_id || !/^\d+$/.test(tx.external_id)) continue;
      backfilledAmounts.set(tx.external_id, parseFloat(tx.amount));

      if (dryRun) {
        tracked.set(tx.external_id, {
          id: 0,
          linkId: link.id,
          splitwiseExpenseId: tx.external_id,
          lmTransactionId: 0,
          splitwiseUpdatedAt: "backfill",
          isDeleted: 0,
          createdAt: "",
          updatedAt: "",
        });
      } else {
        backfillRows.push({
          linkId: link.id,
          splitwiseExpenseId: tx.external_id,
          lmTransactionId: tx.id,
          splitwiseUpdatedAt: "backfill",
        });
      }
    }

    // Batch inserts to stay within Cloudflare Workers subrequest limits
    if (backfillRows.length > 0) {
      let backfilled = 0;
      const BATCH = 100;
      for (let i = 0; i < backfillRows.length; i += BATCH) {
        const result = await db
          .insert(syncedTransactions)
          .values(backfillRows.slice(i, i + BATCH))
          .onConflictDoNothing();
        backfilled += result.rowsAffected;
      }
      log.info("Backfilled existing transactions", {
        lmTransactions: lmTransactions.length,
        matchedByExternalId: backfillRows.length,
        rowsInserted: backfilled,
      });
    } else {
      log.info("First sync, no existing LM transactions to backfill", {
        lmTransactions: lmTransactions.length,
      });
    }
  }

  // Load all tracked rows from DB (includes freshly backfilled ones)
  const rows = await db
    .select()
    .from(syncedTransactions)
    .where(eq(syncedTransactions.linkId, link.id));
  for (const row of rows) {
    tracked.set(row.splitwiseExpenseId, row);
  }

  return { tracked, backfilledAmounts };
}

// Phase 1: Plan what actions the sync would take. Pure decision logic,
// no side effects to LM or the local DB.
async function planSync(
  db: UserDb,
  link: Link,
  user: User,
  dryRun: boolean,
  log: ReturnType<typeof createLogger>,
): Promise<{
  actions: PlannedAction[];
  expenses_fetched: number;
  stamps: { trackedId: number; splitwiseUpdatedAt: string }[];
}> {
  const apiKey = user.lunchMoneyApiKey!;
  const actions: PlannedAction[] = [];
  const stamps: { trackedId: number; splitwiseUpdatedAt: string }[] = [];

  const { tracked, backfilledAmounts } = await buildTrackedMap(db, link, apiKey, dryRun, log);

  const updatedAfter =
    link.lastSyncedAt ?? link.startDate ?? "2000-01-01T00:00:00Z";

  const expenses = await getAllExpenses(user.splitwiseAccessToken, {
    group_id: link.splitwiseGroupId
      ? parseInt(link.splitwiseGroupId, 10)
      : undefined,
    updated_after: updatedAfter,
  });

  log.info("Fetched Splitwise expenses", {
    count: expenses.length,
    updatedAfter,
    trackedCount: tracked.size,
  });

  const skips = { payment: 0, noShare: 0, beforeStart: 0, current: 0 };

  for (const expense of expenses) {
    const eid = String(expense.id);

    if (expense.payment && !link.includePayments) {
      skips.payment++;
      log.debug("Skip expense: payment excluded", { expenseId: eid });
      continue;
    }

    const amount = getUserShare(expense, user.splitwiseUserId);
    const existing = tracked.get(eid);

    // Handle deleted expenses
    if (expense.deleted_at) {
      if (existing && !existing.isDeleted) {
        log.debug("Plan delete", { expenseId: eid, payee: expense.description });
        actions.push({
          type: "delete",
          expenseId: eid,
          date: (expense.date ?? "").split("T")[0],
          payee: expense.description ?? "",
          amount: 0,
          currency: expense.currency_code ?? "USD",
          splitwiseUpdatedAt: expense.updated_at ?? "",
          lmData: {
            date: (expense.date ?? "").split("T")[0],
            amount: 0,
            payee: `[DELETED] ${expense.description}`,
            currency: (expense.currency_code ?? "USD").toLowerCase() as LmInsertTransaction["currency"],
            manual_account_id: link.lmAccountId,
            external_id: eid,
            notes: "",
            status: "reviewed",
          },
          tracked: existing,
        });
      }
      continue;
    }

    if (amount === null) {
      skips.noShare++;
      log.debug("Skip expense: no user share", { expenseId: eid });
      continue;
    }

    // Skip expenses before start_date
    if (link.startDate) {
      const expenseDate = (expense.date ?? "").split("T")[0];
      if (expenseDate < link.startDate) {
        skips.beforeStart++;
        log.debug("Skip expense: before start date", { expenseId: eid, date: expenseDate });
        continue;
      }
    }

    const payee = expense.payment
      ? `Splitwise Payment: ${expense.description}`
      : (expense.description ?? "");

    const lmData = {
      date: (expense.date ?? "").split("T")[0],
      amount,
      payee,
      currency: (expense.currency_code ?? "USD").toLowerCase() as LmInsertTransaction["currency"],
      manual_account_id: link.lmAccountId,
      external_id: eid,
      notes: buildNotes(expense, amount),
      status: "unreviewed" as const,
    };

    if (!existing) {
      log.debug("Plan create", { expenseId: eid, payee, amount });
      actions.push({
        type: "create",
        expenseId: eid,
        date: lmData.date,
        payee,
        amount,
        currency: expense.currency_code ?? "USD",
        splitwiseUpdatedAt: expense.updated_at ?? "",
        lmData,
      });
    } else if (existing.splitwiseUpdatedAt !== expense.updated_at) {
      if (existing.splitwiseUpdatedAt === "backfill") {
        // Backfilled row: only update if the amount has drifted
        const lmAmount = backfilledAmounts.get(eid);
        if (lmAmount !== undefined && lmAmount === amount) {
          log.debug("Stamp backfill (amount matches)", { expenseId: eid, amount });
          stamps.push({
            trackedId: existing.id,
            splitwiseUpdatedAt: expense.updated_at ?? "",
          });
        } else {
          log.debug("Plan update (backfill drift)", {
            expenseId: eid, lmAmount, swAmount: amount,
          });
          actions.push({
            type: "update",
            expenseId: eid,
            date: lmData.date,
            payee,
            amount,
            currency: expense.currency_code ?? "USD",
            splitwiseUpdatedAt: expense.updated_at ?? "",
            lmData,
            tracked: existing,
          });
        }
      } else {
        log.debug("Plan update", { expenseId: eid, payee, amount });
        actions.push({
          type: "update",
          expenseId: eid,
          date: lmData.date,
          payee,
          amount,
          currency: expense.currency_code ?? "USD",
          splitwiseUpdatedAt: expense.updated_at ?? "",
          lmData,
          tracked: existing,
        });
      }
    } else {
      skips.current++;
    }
  }

  log.info("Plan complete", {
    creates: actions.filter((a) => a.type === "create").length,
    updates: actions.filter((a) => a.type === "update").length,
    deletes: actions.filter((a) => a.type === "delete").length,
    stamps: stamps.length,
    skips,
  });

  return { actions, expenses_fetched: expenses.length, stamps };
}

// Phase 2: Execute planned actions against LM and the local DB.
// Batches both API calls and DB writes to stay within subrequest limits.
async function executeActions(
  db: UserDb,
  link: Link,
  apiKey: string,
  actions: PlannedAction[],
  log: ReturnType<typeof createLogger>,
): Promise<{ created: number; updated: number; deleted: number }> {
  const creates = actions.filter((a) => a.type === "create");
  const updates = actions.filter((a) => a.type === "update");
  const deletes = actions.filter((a) => a.type === "delete");

  log.info("Executing actions", {
    creates: creates.length,
    updates: updates.length,
    deletes: deletes.length,
  });

  const dbStmts: Array<{ sql: string; args: (string | number)[] }> = [];

  // Bulk create in LM, then record tracking rows
  if (creates.length > 0) {
    const inserted = await insertTransactions(
      apiKey,
      creates.map((a) => a.lmData),
    );
    log.info("LM insert complete", { requested: creates.length, returned: inserted.length });
    const byExtId = new Map<string, number>();
    for (const tx of inserted) {
      if (tx.external_id) byExtId.set(tx.external_id, tx.id);
    }
    for (const action of creates) {
      const lmId = byExtId.get(action.expenseId);
      if (!lmId) {
        throw new Error(
          `Lunch Money returned no transaction for expense ${action.expenseId}`,
        );
      }
      dbStmts.push({
        sql: "INSERT INTO synced_transactions (link_id, splitwise_expense_id, lm_transaction_id, splitwise_updated_at) VALUES (?, ?, ?, ?)",
        args: [link.id, action.expenseId, lmId, action.splitwiseUpdatedAt],
      });
    }
  }

  // Bulk update in LM
  if (updates.length > 0) {
    await updateTransactions(
      apiKey,
      updates.map((a) => ({
        id: a.tracked!.lmTransactionId,
        amount: a.lmData.amount,
        currency: a.lmData.currency,
        notes: a.lmData.notes,
      })),
    );
    log.info("LM update complete", { count: updates.length });
    for (const action of updates) {
      dbStmts.push({
        sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, is_deleted = 0, updated_at = datetime('now') WHERE id = ?",
        args: [action.splitwiseUpdatedAt, action.tracked!.id],
      });
    }
  }

  // Bulk delete (zero out) in LM
  if (deletes.length > 0) {
    await updateTransactions(
      apiKey,
      deletes.map((a) => ({
        id: a.tracked!.lmTransactionId,
        payee: a.lmData.payee,
        amount: 0,
      })),
    );
    log.info("LM delete (zero-out) complete", { count: deletes.length });
    for (const action of deletes) {
      dbStmts.push({
        sql: "UPDATE synced_transactions SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?",
        args: [action.tracked!.id],
      });
    }
  }

  // Batch all DB writes
  if (dbStmts.length > 0) {
    const BATCH = 100;
    for (let i = 0; i < dbStmts.length; i += BATCH) {
      await db.$client.batch(dbStmts.slice(i, i + BATCH));
    }
    log.info("DB writes complete", { statements: dbStmts.length });
  }

  return {
    created: creates.length,
    updated: updates.length,
    deleted: deletes.length,
  };
}

export async function syncLink(
  db: UserDb,
  link: Link,
  user: User,
  options?: SyncOptions,
): Promise<SyncResult> {
  const apiKey = user.lunchMoneyApiKey;
  if (!apiKey) throw new Error("Lunch Money API key not configured");

  const dryRun = options?.dryRun ?? false;
  const log = createLogger({ userId: user.id, linkId: link.id, dryRun });
  const syncStartedAt = new Date().toISOString();

  log.info("Sync started", {
    groupId: link.splitwiseGroupId,
    lmAccountId: link.lmAccountId,
    lastSyncedAt: link.lastSyncedAt,
    startDate: link.startDate,
  });

  // Plan phase: decide what to do (shared logic for dry run and real sync)
  const { actions, expenses_fetched, stamps } = await planSync(db, link, user, dryRun, log);

  const result: SyncResult = {
    expenses_fetched,
    created: actions.filter((a) => a.type === "create").length,
    updated: actions.filter((a) => a.type === "update").length,
    deleted: actions.filter((a) => a.type === "delete").length,
  };

  if (dryRun) {
    result.actions = actions;
    return result;
  }

  // Execute phase: apply actions to LM and local DB
  let logEntryId: number;
  {
    const [logEntry] = await db
      .insert(syncLog)
      .values({ linkId: link.id, startedAt: syncStartedAt })
      .returning({ id: syncLog.id });
    logEntryId = logEntry.id;
  }

  try {
    await executeActions(db, link, apiKey, actions, log);

    // Record timestamps for backfilled rows (no LM update needed).
    // Batch to stay within Cloudflare Workers subrequest limits.
    if (stamps.length > 0) {
      const stmts = stamps.map((s) => ({
        sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, updated_at = datetime('now') WHERE id = ?",
        args: [s.splitwiseUpdatedAt, s.trackedId],
      }));
      const BATCH = 100;
      for (let i = 0; i < stmts.length; i += BATCH) {
        await db.$client.batch(stmts.slice(i, i + BATCH));
      }
      log.info("Stamped backfill rows", { count: stamps.length });
    }

    // Update sync cursor
    await db
      .update(links)
      .set({ lastSyncedAt: syncStartedAt, updatedAt: sql`datetime('now')` })
      .where(eq(links.id, link.id));

    await db
      .update(syncLog)
      .set({
        finishedAt: sql`datetime('now')`,
        status: "success",
        expensesFetched: result.expenses_fetched,
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
      })
      .where(eq(syncLog.id, logEntryId));

    log.info("Sync complete", {
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
    });
  } catch (err) {
    log.error("Sync failed", { error: describeError(err) });
    await db
      .update(syncLog)
      .set({
        finishedAt: sql`datetime('now')`,
        status: "error",
        expensesFetched: result.expenses_fetched,
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        errorMessage: describeError(err),
      })
      .where(eq(syncLog.id, logEntryId));
    throw err;
  }

  return result;
}

// Sync Splitwise balances to Lunch Money account balances.
// Groups balance-enabled links by LM account and sums balances across
// all linked Splitwise groups, converting currencies as needed.
export async function syncBalances(
  enabledLinks: Link[],
  user: User,
  rates: ExchangeRates,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const balanceLinks = enabledLinks.filter((l) => l.syncBalance === 1);
  if (balanceLinks.length === 0) return;

  const apiKey = user.lunchMoneyApiKey;
  if (!apiKey) return;

  const lmUser = await getUser(apiKey);
  const targetCurrency = lmUser.primary_currency.toUpperCase();

  // Group links by LM account
  const byAccount = new Map<number, Link[]>();
  for (const link of balanceLinks) {
    const existing = byAccount.get(link.lmAccountId) ?? [];
    existing.push(link);
    byAccount.set(link.lmAccountId, existing);
  }

  for (const [accountId, accountLinks] of byAccount) {
    try {
      let totalBalance = 0;

      // Deduplicate groups across links targeting the same LM account
      // (e.g. an "all groups" link + a specific-group link would double-count)
      const seenGroupIds = new Set<number>();

      for (const link of accountLinks) {
        const groups = link.splitwiseGroupId
          ? [await getGroup(user.splitwiseAccessToken, parseInt(link.splitwiseGroupId, 10))]
          : await getGroups(user.splitwiseAccessToken);

        for (const group of groups) {
          if (!group) continue;
          const gid = group.id ?? -1;
          if (seenGroupIds.has(gid)) continue;
          seenGroupIds.add(gid);

          const balances = getUserBalances(group, user.splitwiseUserId);
          for (const { currency, amount } of balances) {
            const converted = convertCurrency(
              amount,
              currency,
              targetCurrency,
              rates,
            );
            totalBalance += converted;
          }
        }
      }

      // Round to 4 decimal places (LM precision limit)
      totalBalance = Math.round(totalBalance * 10000) / 10000;

      await updateAccountBalance(apiKey, accountId, totalBalance);
      log.info("Balance synced", {
        accountId,
        balance: totalBalance,
        currency: targetCurrency,
      });
    } catch (err) {
      log.error("Balance sync failed for account", {
        accountId,
        error: describeError(err),
      });
    }
  }
}

export async function syncAllEnabled(): Promise<void> {
  const log = createLogger({ source: "cron" });
  const cronStart = Date.now();

  const shared = getSharedDb();
  const allUsers = await shared
    .select()
    .from(users)
    .where(isNotNull(users.tursoDbUrl));

  log.info("Cron started", { users: allUsers.length });

  // Fetch exchange rates once for all balance syncs this run (cached in shared DB)
  let exchangeRates: ExchangeRates | null = null;
  try {
    exchangeRates = await getExchangeRates(shared);
    log.info("Exchange rates loaded", { currencies: Object.keys(exchangeRates).length });
  } catch (err) {
    log.warn("Failed to load exchange rates, skipping balance sync", {
      error: describeError(err),
    });
  }

  let totalLinks = 0;
  let successes = 0;
  let failures = 0;

  for (const row of allUsers) {
    const userLog = log.with({ userId: row.id });
    const userDb = getUserDb(row.tursoDbUrl!);
    await initUserDb(userDb);

    // Clean up stale sync_log entries from interrupted runs
    const cleaned = await userDb.run(sql`
      UPDATE sync_log
      SET status = 'error', finished_at = datetime('now'), error_message = 'Process interrupted'
      WHERE status = 'running'
    `);
    if (cleaned.rowsAffected > 0) {
      userLog.warn("Cleaned stale sync_log entries", { count: cleaned.rowsAffected });
    }

    const creds = await userDb.select().from(credentials).limit(1);
    const cred = creds[0];
    if (!cred?.lunchMoneyApiKey) {
      userLog.warn("Skipping user: no Lunch Money API key");
      continue;
    }

    const enabledLinks = await userDb
      .select()
      .from(links)
      .where(eq(links.enabled, 1));

    userLog.info("Processing user", { enabledLinks: enabledLinks.length });
    totalLinks += enabledLinks.length;

    const user: User = {
      id: row.id,
      splitwiseUserId: row.splitwiseUserId,
      tursoDbUrl: row.tursoDbUrl!,
      splitwiseAccessToken: await decrypt(cred.splitwiseAccessToken),
      lunchMoneyApiKey: await decrypt(cred.lunchMoneyApiKey),
    };

    for (const link of enabledLinks) {
      try {
        await syncLink(userDb, link, user);
        successes++;
      } catch (err) {
        failures++;
        // syncLink already logs the error, no need to duplicate
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    // Balance sync (after all transaction syncs for this user)
    if (exchangeRates) {
      try {
        await syncBalances(enabledLinks, user, exchangeRates, userLog);
      } catch (err) {
        userLog.error("Balance sync failed", { error: describeError(err) });
      }
    }
  }

  log.info("Cron complete", {
    users: allUsers.length,
    totalLinks,
    successes,
    failures,
    elapsedMs: Date.now() - cronStart,
  });
}
