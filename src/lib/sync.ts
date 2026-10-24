import { eq, sql } from "drizzle-orm";
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
  getCategories,
  getUser,
  updateAccountBalance,
  type LmInsertTransaction,
  type LmCategory,
} from "./lunch-money.js";
import { convertCurrency, type ExchangeRates } from "./exchange-rates.js";
import type { User } from "./auth.js";
import { decrypt } from "./crypto.js";
import { stemmer } from "stemmer";
import { createLogger } from "./logger.js";
import { describeError, INTERRUPTED_MESSAGE } from "./errors.js";
import { logSyncFailure } from "./sync-failure.js";
import { requestBudgetExceeded } from "./request-budget.js";

type Link = typeof links.$inferSelect;

type TrackedRow = typeof syncedTransactions.$inferSelect;

// Statements (or rows, for a multi-row insert) per Turso request.
const DB_BATCH = 1000;

interface ActionBase {
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
    category_id?: number;
  };
}

interface PlannedCreate extends ActionBase {
  type: "create";
}

interface PlannedUpdate extends ActionBase {
  type: "update";
  tracked: TrackedRow;
}

interface PlannedDelete extends ActionBase {
  type: "delete";
  tracked: TrackedRow;
}

export type PlannedAction = PlannedCreate | PlannedUpdate | PlannedDelete;

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

// Stem all words in a string and return as a sorted set for comparison
function stemWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 0)
        .map((w) => stemmer(w)),
    ),
  ].sort();
}

// Build a map from stemmed category names to LM category IDs.
// Skips category groups (which can't be assigned to transactions).
// If multiple LM categories produce the same stemmed key, the key is
// removed to avoid ambiguous matches.
function buildCategoryMap(categories: LmCategory[]): Map<string, number> {
  const map = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const cat of categories) {
    if (cat.is_group) continue;
    const key = stemWords(cat.name).join(" ");
    if (map.has(key) && map.get(key) !== cat.id) {
      ambiguous.add(key);
    } else {
      map.set(key, cat.id);
    }
  }
  for (const key of ambiguous) map.delete(key);
  return map;
}

// Match a Splitwise category name to a LM category ID.
// Tries exact stemmed match first, then substring (one stemmed set
// contains all words of the other).
function matchCategory(
  swCategoryName: string | undefined,
  categoryMap: Map<string, number>,
): number | undefined {
  if (!swCategoryName) return undefined;
  const swStems = stemWords(swCategoryName);
  if (swStems.length === 0) return undefined;
  const swKey = swStems.join(" ");

  // Exact stemmed match
  if (categoryMap.has(swKey)) return categoryMap.get(swKey);

  // Substring: SW stems are a subset of LM stems, or vice versa
  const matches: number[] = [];
  for (const [lmKey, lmId] of categoryMap) {
    const lmStems = lmKey.split(" ");
    if (swStems.every((s) => lmStems.includes(s)) || lmStems.every((s) => swStems.includes(s))) {
      matches.push(lmId);
    }
  }
  if (matches.length === 1) return matches[0];
  return undefined;
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
      for (let i = 0; i < backfillRows.length; i += DB_BATCH) {
        const result = await db
          .insert(syncedTransactions)
          .values(backfillRows.slice(i, i + DB_BATCH))
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

function planUpdate(
  eid: string,
  expense: SplitwiseExpense,
  lmData: ActionBase["lmData"],
  payee: string,
  amount: number,
  existing: TrackedRow,
): PlannedUpdate {
  return {
    type: "update",
    expenseId: eid,
    date: lmData.date,
    payee,
    amount,
    currency: expense.currency_code ?? "USD",
    splitwiseUpdatedAt: expense.updated_at ?? "",
    lmData,
    tracked: existing,
  };
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

  // Build category map for matching Splitwise categories to LM categories
  const lmCategories = await getCategories(apiKey);
  const categoryMap = buildCategoryMap(lmCategories);

  // Subtract 2 minutes from lastSyncedAt to cover expenses updated during the
  // previous fetch window (TOCTOU). Re-fetching overlapping expenses is safe
  // because the planner skips already-synced ones (matching splitwiseUpdatedAt).
  let updatedAfter = link.startDate ?? "2000-01-01T00:00:00Z";
  if (link.lastSyncedAt) {
    const d = new Date(link.lastSyncedAt);
    d.setMinutes(d.getMinutes() - 2);
    updatedAfter = d.toISOString();
  }

  const expenses = await getAllExpenses(user.splitwiseAccessToken, {
    group_id: link.splitwiseGroupId ? parseInt(link.splitwiseGroupId, 10) : undefined,
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
            currency: (
              expense.currency_code ?? "USD"
            ).toLowerCase() as LmInsertTransaction["currency"],
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

    const lmData: PlannedAction["lmData"] = {
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
      const categoryId = matchCategory(expense.category?.name, categoryMap);
      if (categoryId) lmData.category_id = categoryId;
      log.debug("Plan create", { expenseId: eid, payee, amount, categoryId });
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
            expenseId: eid,
            lmAmount,
            swAmount: amount,
          });
          actions.push(planUpdate(eid, expense, lmData, payee, amount, existing));
        }
      } else {
        log.debug("Plan update", { expenseId: eid, payee, amount });
        actions.push(planUpdate(eid, expense, lmData, payee, amount, existing));
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
  const creates = actions.filter((a): a is PlannedCreate => a.type === "create");
  const updates = actions.filter((a): a is PlannedUpdate => a.type === "update");
  const deletes = actions.filter((a): a is PlannedDelete => a.type === "delete");

  log.info("Executing actions", {
    creates: creates.length,
    updates: updates.length,
    deletes: deletes.length,
  });

  const dbStmts: Array<{ sql: string; args: (string | number)[] }> = [];

  // Bulk create in LM, then record tracking rows
  if (creates.length > 0) {
    const result = await insertTransactions(
      apiKey,
      creates.map((a) => a.lmData),
    );
    log.info("LM insert complete", {
      requested: creates.length,
      returned: result.transactions.length,
      skipped: result.skippedDuplicates.length,
    });

    // Build ID map from both successful inserts and skipped duplicates
    const byExtId = new Map<string, number>();
    for (const tx of result.transactions) {
      if (tx.external_id) byExtId.set(tx.external_id, tx.id);
    }
    for (const dup of result.skippedDuplicates) {
      const extId = dup.request_transaction?.external_id;
      if (extId && dup.existing_transaction_id) {
        byExtId.set(extId, dup.existing_transaction_id);
      }
    }

    for (const action of creates) {
      const lmId = byExtId.get(action.expenseId);
      if (!lmId) {
        // Skip rather than throw -- the next sync will retry this expense
        // and LM will return it as a skipped duplicate with the existing ID
        log.error("No LM transaction ID for expense after insert", {
          expenseId: action.expenseId,
        });
        continue;
      }
      dbStmts.push({
        sql: "INSERT INTO synced_transactions (link_id, splitwise_expense_id, lm_transaction_id, splitwise_updated_at) VALUES (?, ?, ?, ?)",
        args: [link.id, action.expenseId, lmId, action.splitwiseUpdatedAt],
      });
    }
  }

  // A transaction the user deleted in LM stays deleted. The stamp keeps the
  // planner from re-planning the same edit on every sync.
  let gone = 0;
  function stopTracking(action: PlannedUpdate | PlannedDelete) {
    gone++;
    log.warn("LM transaction no longer exists, no longer tracking expense", {
      expenseId: action.expenseId,
      lmTransactionId: action.tracked.lmTransactionId,
    });
    dbStmts.push({
      sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, is_deleted = 1, updated_at = datetime('now') WHERE id = ?",
      args: [action.splitwiseUpdatedAt, action.tracked.id],
    });
  }

  // Bulk update in LM
  let updated = 0;
  if (updates.length > 0) {
    const { missingIds } = await updateTransactions(
      apiKey,
      updates.map((a) => ({
        id: a.tracked.lmTransactionId,
        amount: a.lmData.amount,
        currency: a.lmData.currency,
        notes: a.lmData.notes,
      })),
    );
    const missing = new Set(missingIds);
    for (const action of updates) {
      if (missing.has(action.tracked.lmTransactionId)) {
        stopTracking(action);
        continue;
      }
      updated++;
      dbStmts.push({
        sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, is_deleted = 0, updated_at = datetime('now') WHERE id = ?",
        args: [action.splitwiseUpdatedAt, action.tracked.id],
      });
    }
    log.info("LM update complete", { count: updated, missing: missing.size });
  }

  // Bulk delete (zero out) in LM
  let deleted = 0;
  if (deletes.length > 0) {
    const { missingIds } = await updateTransactions(
      apiKey,
      deletes.map((a) => ({
        id: a.tracked.lmTransactionId,
        payee: a.lmData.payee,
        amount: 0,
      })),
    );
    const missing = new Set(missingIds);
    for (const action of deletes) {
      if (missing.has(action.tracked.lmTransactionId)) {
        stopTracking(action);
        continue;
      }
      deleted++;
      dbStmts.push({
        sql: "UPDATE synced_transactions SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?",
        args: [action.tracked.id],
      });
    }
    log.info("LM delete (zero-out) complete", { count: deleted, missing: missing.size });
  }

  // Batch all DB writes at the end to minimize subrequests. Each batch() call
  // is one subrequest to Turso, and Workers Free allows 50 subrequests per
  // invocation. Writing incrementally after each phase would use more. If a
  // later phase fails, earlier phases' LM changes are orphaned, but the next
  // sync self-heals via duplicate external_id handling in the creates path.
  if (dbStmts.length > 0) {
    try {
      for (let i = 0; i < dbStmts.length; i += DB_BATCH) {
        await db.$client.batch(dbStmts.slice(i, i + DB_BATCH));
      }
      log.info("DB writes complete", { statements: dbStmts.length });
    } catch (err) {
      if (requestBudgetExceeded()) throw err;
      log.error("DB writes failed after LM operations completed", {
        error: describeError(err),
        cause: err,
        lmCreated: creates.length,
        lmUpdated: updated,
        lmDeleted: deleted,
        lmGone: gone,
      });
      throw err;
    }
  }

  return { created: creates.length, updated, deleted };
}

function countActions(
  actions: PlannedAction[],
): Pick<SyncResult, "created" | "updated" | "deleted"> {
  return {
    created: actions.filter((a) => a.type === "create").length,
    updated: actions.filter((a) => a.type === "update").length,
    deleted: actions.filter((a) => a.type === "delete").length,
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

  if (dryRun) {
    const { actions, expenses_fetched } = await planSync(db, link, user, dryRun, log);
    return { expenses_fetched, ...countActions(actions), actions };
  }

  const result: SyncResult = { expenses_fetched: 0, created: 0, updated: 0, deleted: 0 };
  let logEntryId: number | undefined;

  try {
    const [logEntry] = await db
      .insert(syncLog)
      .values({ linkId: link.id, startedAt: syncStartedAt })
      .returning({ id: syncLog.id });
    logEntryId = logEntry.id;

    const { actions, expenses_fetched, stamps } = await planSync(db, link, user, dryRun, log);
    Object.assign(result, { expenses_fetched, ...countActions(actions) });

    const counts = await executeActions(db, link, apiKey, actions, log);
    Object.assign(result, counts);

    // Record timestamps for backfilled rows (no LM update needed).
    // Batch to stay within Cloudflare Workers subrequest limits.
    if (stamps.length > 0) {
      try {
        const stmts = stamps.map((s) => ({
          sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, updated_at = datetime('now') WHERE id = ?",
          args: [s.splitwiseUpdatedAt, s.trackedId],
        }));
        for (let i = 0; i < stmts.length; i += DB_BATCH) {
          await db.$client.batch(stmts.slice(i, i + DB_BATCH));
        }
        log.info("Stamped backfill rows", { count: stamps.length });
      } catch (err) {
        if (requestBudgetExceeded()) throw err;
        log.error("Stamp writes failed after sync completed", {
          error: describeError(err),
          cause: err,
          stamps: stamps.length,
        });
        throw err;
      }
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
        created: counts.created,
        updated: counts.updated,
        deleted: counts.deleted,
      })
      .where(eq(syncLog.id, logEntryId));

    log.info("Sync complete", {
      created: counts.created,
      updated: counts.updated,
      deleted: counts.deleted,
    });
  } catch (err) {
    // a sync_log write would be refused, and the consumer's budget report needs the Sentry headroom
    if (requestBudgetExceeded()) throw err;
    logSyncFailure(log, "Sync failed", err);
    if (logEntryId !== undefined) {
      try {
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
      } catch (logErr) {
        log.error("Failed to record sync error in sync_log", {
          error: describeError(logErr),
          cause: logErr,
        });
      }
    }
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
            const converted = convertCurrency(amount, currency, targetCurrency, rates);
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
      if (requestBudgetExceeded()) throw err;
      logSyncFailure(log, "Balance sync failed for account", err, { accountId });
    }
  }
}

// Throws when the user's setup fails or the request budget runs out. A failed link doesn't
// throw, since syncLink records it in sync_log.
export async function syncUser(userId: number, exchangeRates: ExchangeRates | null): Promise<void> {
  const log = createLogger({ userId });

  const [row] = await getSharedDb().select().from(users).where(eq(users.id, userId));
  if (!row?.tursoDbUrl) {
    log.warn("Skipping user: no database");
    return;
  }

  const userDb = getUserDb(row.tursoDbUrl);
  await initUserDb(userDb);

  // Clean up stale sync_log entries from interrupted runs
  const cleaned = await userDb.run(sql`
    UPDATE sync_log
    SET status = 'error', finished_at = datetime('now'), error_message = ${INTERRUPTED_MESSAGE}
    WHERE status = 'running'
  `);
  if (cleaned.rowsAffected > 0) {
    log.warn("Cleaned stale sync_log entries", { count: cleaned.rowsAffected });
  }

  const creds = await userDb.select().from(credentials).limit(1);
  const cred = creds[0];
  if (!cred?.lunchMoneyApiKey) {
    log.warn("Skipping user: no Lunch Money API key");
    return;
  }

  const enabledLinks = await userDb.select().from(links).where(eq(links.enabled, 1));
  log.info("Processing user", { enabledLinks: enabledLinks.length });

  const user: User = {
    id: row.id,
    splitwiseUserId: row.splitwiseUserId,
    tursoDbUrl: row.tursoDbUrl,
    splitwiseAccessToken: await decrypt(cred.splitwiseAccessToken),
    lunchMoneyApiKey: await decrypt(cred.lunchMoneyApiKey),
  };

  let successes = 0;
  let failures = 0;
  for (const [i, link] of enabledLinks.entries()) {
    if (i > 0) {
      await new Promise<void>((r) => {
        setTimeout(r, 500);
      });
    }
    try {
      await syncLink(userDb, link, user);
      successes++;
    } catch (err) {
      if (requestBudgetExceeded()) throw err;
      failures++;
      // syncLink has logged it and recorded it in sync_log
    }
  }

  if (exchangeRates) {
    try {
      await syncBalances(enabledLinks, user, exchangeRates, log);
    } catch (err) {
      if (requestBudgetExceeded()) throw err;
      logSyncFailure(log, "Balance sync failed", err);
    }
  }

  log.info("User sync complete", { links: enabledLinks.length, successes, failures });
}
