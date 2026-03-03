import { eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getSharedDb, getUserDb, type UserDb } from "./db.js";
import { users } from "./schema-shared.js";
import { credentials, links, syncedTransactions, syncLog } from "./schema-user.js";
import {
  getAllExpenses,
  getUserShare,
  type SplitwiseExpense,
} from "./splitwise.js";
import {
  insertTransactions,
  updateTransaction,
  getTransactions,
  type LmInsertTransaction,
} from "./lunch-money.js";
import type { User } from "./auth.js";
import { decrypt } from "./crypto.js";

type Link = typeof links.$inferSelect;
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
    status: "reviewed";
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

// On first sync, backfill synced_transactions from existing LM transactions
// so we don't re-create ones from a prior local sync script.
async function backfillExisting(
  db: UserDb,
  link: Link,
  apiKey: string,
): Promise<void> {
  const startDate = link.startDate ?? "2000-01-01";
  const lmTransactions = await getTransactions(apiKey, {
    manual_account_id: link.lmAccountId,
    start_date: startDate,
  });

  let backfilled = 0;
  for (const tx of lmTransactions) {
    if (!tx.external_id) continue;
    if (!/^\d+$/.test(tx.external_id)) continue;

    const inserted = await db
      .insert(syncedTransactions)
      .values({
        linkId: link.id,
        splitwiseExpenseId: tx.external_id,
        lmTransactionId: tx.id,
        splitwiseUpdatedAt: "",
      })
      .onConflictDoNothing();
    if (inserted.rowsAffected > 0) backfilled++;
  }

  if (backfilled > 0) {
    console.log(
      `Backfilled ${backfilled} existing transactions for link ${link.id}`,
    );
  }
}

// Scan LM transactions and return expense IDs that already exist there
// (used for dry-run backfill simulation).
async function getBackfilledIds(
  link: Link,
  apiKey: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const startDate = link.startDate ?? "2000-01-01";
  const lmTransactions = await getTransactions(apiKey, {
    manual_account_id: link.lmAccountId,
    start_date: startDate,
  });

  for (const tx of lmTransactions) {
    if (!tx.external_id) continue;
    if (!/^\d+$/.test(tx.external_id)) continue;
    ids.add(tx.external_id);
  }

  return ids;
}

// Build a map of tracked expenses. For first sync, either runs real backfill
// (mutates DB) or simulates it (in-memory only).
async function buildTrackedMap(
  db: UserDb,
  link: Link,
  apiKey: string,
  dryRun: boolean,
): Promise<Map<string, TrackedRow>> {
  const tracked = new Map<string, TrackedRow>();

  if (!link.lastSyncedAt) {
    if (dryRun) {
      const backfilledIds = await getBackfilledIds(link, apiKey);
      for (const id of backfilledIds) {
        tracked.set(id, {
          id: 0,
          linkId: link.id,
          splitwiseExpenseId: id,
          lmTransactionId: 0,
          splitwiseUpdatedAt: "",
          isDeleted: 0,
          createdAt: "",
          updatedAt: "",
        });
      }
    } else {
      await backfillExisting(db, link, apiKey);
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

  return tracked;
}

// Phase 1: Plan what actions the sync would take. Pure decision logic,
// no side effects to LM or the local DB.
async function planSync(
  db: UserDb,
  link: Link,
  user: User,
  dryRun: boolean,
): Promise<{ actions: PlannedAction[]; expenses_fetched: number }> {
  const apiKey = user.lunchMoneyApiKey!;
  const actions: PlannedAction[] = [];

  const tracked = await buildTrackedMap(db, link, apiKey, dryRun);

  const updatedAfter =
    link.lastSyncedAt ?? link.startDate ?? "2000-01-01T00:00:00Z";

  const expenses = await getAllExpenses(user.splitwiseAccessToken, {
    group_id: link.splitwiseGroupId
      ? parseInt(link.splitwiseGroupId, 10)
      : undefined,
    updated_after: updatedAfter,
  });

  for (const expense of expenses) {
    if (expense.payment && !link.includePayments) continue;

    const amount = getUserShare(expense, user.splitwiseUserId);
    const existing = tracked.get(String(expense.id));

    // Handle deleted expenses
    if (expense.deleted_at) {
      if (existing && !existing.isDeleted) {
        actions.push({
          type: "delete",
          expenseId: String(expense.id),
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
            external_id: String(expense.id),
            notes: "",
            status: "reviewed",
          },
          tracked: existing,
        });
      }
      continue;
    }

    if (amount === null) continue;

    // Skip expenses before start_date
    if (link.startDate) {
      const expenseDate = (expense.date ?? "").split("T")[0];
      if (expenseDate < link.startDate) continue;
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
      external_id: String(expense.id),
      notes: buildNotes(expense, amount),
      status: "reviewed" as const,
    };

    if (!existing) {
      actions.push({
        type: "create",
        expenseId: String(expense.id),
        date: lmData.date,
        payee,
        amount,
        currency: expense.currency_code ?? "USD",
        splitwiseUpdatedAt: expense.updated_at ?? "",
        lmData,
      });
    } else if (existing.splitwiseUpdatedAt !== expense.updated_at) {
      actions.push({
        type: "update",
        expenseId: String(expense.id),
        date: lmData.date,
        payee,
        amount,
        currency: expense.currency_code ?? "USD",
        splitwiseUpdatedAt: expense.updated_at ?? "",
        lmData,
        tracked: existing,
      });
    }
  }

  return { actions, expenses_fetched: expenses.length };
}

// Phase 2: Execute planned actions against LM and the local DB.
async function executeActions(
  db: UserDb,
  link: Link,
  apiKey: string,
  actions: PlannedAction[],
): Promise<{ created: number; updated: number; deleted: number }> {
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const action of actions) {
    if (action.type === "create") {
      const inserted = await insertTransactions(apiKey, [action.lmData]);
      if (!inserted || inserted.length === 0) {
        throw new Error(
          `Lunch Money returned no transactions for expense ${action.expenseId}`,
        );
      }
      await db.insert(syncedTransactions).values({
        linkId: link.id,
        splitwiseExpenseId: action.expenseId,
        lmTransactionId: inserted[0].id,
        splitwiseUpdatedAt: action.splitwiseUpdatedAt,
      });
      created++;
    } else if (action.type === "update") {
      await updateTransaction(apiKey, action.tracked!.lmTransactionId, action.lmData);
      await db
        .update(syncedTransactions)
        .set({
          splitwiseUpdatedAt: action.splitwiseUpdatedAt,
          isDeleted: 0,
          updatedAt: sql`datetime('now')`,
        })
        .where(eq(syncedTransactions.id, action.tracked!.id));
      updated++;
    } else if (action.type === "delete") {
      await updateTransaction(apiKey, action.tracked!.lmTransactionId, {
        payee: action.lmData.payee,
        amount: 0,
      });
      await db
        .update(syncedTransactions)
        .set({ isDeleted: 1, updatedAt: sql`datetime('now')` })
        .where(eq(syncedTransactions.id, action.tracked!.id));
      deleted++;
    }
  }

  return { created, updated, deleted };
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
  const syncStartedAt = new Date().toISOString();

  // Plan phase: decide what to do (shared logic for dry run and real sync)
  const { actions, expenses_fetched } = await planSync(db, link, user, dryRun);

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
    await executeActions(db, link, apiKey, actions);

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncLog)
      .set({
        finishedAt: sql`datetime('now')`,
        status: "error",
        expensesFetched: result.expenses_fetched,
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        errorMessage: message,
      })
      .where(eq(syncLog.id, logEntryId));
    throw err;
  }

  return result;
}

export async function syncAllEnabled(): Promise<void> {
  const shared = getSharedDb();
  const allUsers = await shared
    .select()
    .from(users)
    .where(isNotNull(users.tursoDbUrl));

  for (const row of allUsers) {
    const userDb = getUserDb(row.tursoDbUrl!);

    // Clean up stale sync_log entries from interrupted runs
    await userDb.run(sql`
      UPDATE sync_log
      SET status = 'error', finished_at = datetime('now'), error_message = 'Process interrupted'
      WHERE status = 'running'
    `);

    const creds = await userDb.select().from(credentials).limit(1);
    const cred = creds[0];
    if (!cred?.lunchMoneyApiKey) continue;

    const enabledLinks = await userDb
      .select()
      .from(links)
      .where(eq(links.enabled, 1));

    const user: User = {
      id: row.id,
      splitwiseUserId: row.splitwiseUserId,
      tursoDbUrl: row.tursoDbUrl!,
      splitwiseAccessToken: await decrypt(cred.splitwiseAccessToken),
      lunchMoneyApiKey: await decrypt(cred.lunchMoneyApiKey),
    };

    for (const link of enabledLinks) {
      try {
        const result = await syncLink(userDb, link, user);
        console.log(
          `Synced link ${link.id} (user ${row.id}): ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
        );
      } catch (err) {
        console.error(`Sync failed for link ${link.id} (user ${row.id}):`, err);
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
