import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, sql } from "drizzle-orm";
import * as sharedSchema from "./schema-shared.js";
import * as userSchema from "./schema-user.js";
import { credentials, syncedTransactions, syncLog, links } from "./schema-user.js";
import { getSharedDb, getUserDb, initUserDb, type SharedDb, type UserDb } from "./db.js";
import {
  CATCH_UP_OVERLAP,
  EXPENSE_PAGES_PER_RUN,
  syncLink,
  syncBalances,
  syncUser,
} from "./sync.js";
import { env } from "./env.js";
import { encrypt } from "./crypto.js";
import { apiError } from "./errors.js";
import {
  countedFetch,
  REQUEST_BUDGET,
  RequestBudgetExceededError,
  withRequestBudget,
} from "./request-budget.js";
import {
  EXPENSE_PAGE_SIZE,
  getUserShare,
  getExpenses,
  getGroups,
  getGroup,
  type SplitwiseExpense,
  type SplitwiseGroup,
} from "./splitwise.js";
import {
  getTransactions,
  insertTransactions,
  updateTransactions,
  getCategories,
  getUser,
  updateAccountBalance,
} from "./lunch-money.js";
import { convertCurrency, type ExchangeRates } from "./exchange-rates.js";
import type { User } from "./auth.js";

vi.mock("./db.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./db.js")>();
  return { ...mod, getSharedDb: vi.fn(), getUserDb: vi.fn() };
});

vi.mock("./splitwise.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./splitwise.js")>();
  return {
    ...mod,
    getExpenses: vi.fn().mockResolvedValue({ expenses: [], nextOffset: null }),
    getGroups: vi.fn().mockResolvedValue([]),
    getGroup: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("./lunch-money.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./lunch-money.js")>();
  return {
    ...mod,
    getTransactions: vi.fn().mockResolvedValue([]),
    insertTransactions: vi.fn().mockResolvedValue({ transactions: [], skippedDuplicates: [] }),
    updateTransactions: vi.fn().mockResolvedValue({ missingIds: [] }),
    getCategories: vi.fn().mockResolvedValue([]),
    getUser: vi.fn().mockResolvedValue({ primary_currency: "usd" }),
    updateAccountBalance: vi.fn().mockResolvedValue(void 0),
  };
});

vi.mock("./exchange-rates.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./exchange-rates.js")>();
  return {
    ...mod,
    getExchangeRates: vi.fn().mockResolvedValue({ USD: 1, EUR: 0.85 }),
  };
});

const mockGetExpenses = getExpenses as Mock;
const mockGetTransactions = getTransactions as Mock;
const mockInsertTransactions = insertTransactions as Mock;
const mockUpdateTransactions = updateTransactions as Mock;
const mockGetCategories = getCategories as Mock;
const mockGetGroups = getGroups as Mock;
const mockGetGroup = getGroup as Mock;
const mockGetUser = getUser as Mock;
const mockUpdateAccountBalance = updateAccountBalance as Mock;

// --- Helpers ---

function createTestDb(): UserDb {
  const client = createClient({ url: ":memory:" });
  return drizzle({ client, schema: userSchema }) as UserDb;
}

function makeExpense(overrides: Partial<SplitwiseExpense> = {}): SplitwiseExpense {
  return {
    id: 1,
    description: "Test expense",
    cost: "20.00",
    currency_code: "USD",
    date: "2024-06-15T00:00:00Z",
    updated_at: "2024-06-15T12:00:00Z",
    deleted_at: null,
    payment: false,
    users: [{ user_id: 123, net_balance: "-10.00" }],
    ...overrides,
  } as SplitwiseExpense;
}

// one run's fetch of the Splitwise listing, all of it unless nextOffset says where the rest starts
function fetched(expenses: SplitwiseExpense[], nextOffset: number | null = null) {
  return { expenses, nextOffset };
}

function makeLink(
  overrides: Partial<typeof userSchema.links.$inferSelect> = {},
): typeof userSchema.links.$inferSelect {
  return {
    id: 1,
    splitwiseGroupId: "10",
    lmAccountId: 100,
    startDate: null,
    includePayments: 0,
    enabled: 1,
    syncBalance: 1,
    lastSyncedAt: null,
    catchUpOffset: null,
    catchUpStartedAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

// Makes requests until the budget refuses one, with the network stubbed out.
async function exhaustRequestBudget(): Promise<never> {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
  for (let i = 0; i < REQUEST_BUDGET; i++) {
    await countedFetch("https://example.com/");
  }
  await countedFetch("https://example.com/");
  throw new Error("request budget was not enforced");
}

// The logger's error lines, which it also reports to Sentry. Needs console.error spied on.
function loggedErrors(): { msg: string; linkId: number }[] {
  return vi.mocked(console.error).mock.calls.map(([line]) => {
    const { msg, linkId } = JSON.parse(String(line)) as { msg: string; linkId: number };
    return { msg, linkId };
  });
}

// Needs console.warn spied on.
function loggedWarnings(): string[] {
  return vi.mocked(console.warn).mock.calls.map(([line]) => {
    return (JSON.parse(String(line)) as { msg: string }).msg;
  });
}

const lunchMoneyRejection = () => apiError("Lunch Money", 401, { message: "Unauthorized" });
const splitwiseRejection = () =>
  apiError("Splitwise", 401, { error: "Invalid API request: you are not logged in" });

const defaultUser: User = {
  id: 1,
  splitwiseUserId: "123",
  tursoDbUrl: ":memory:",
  splitwiseAccessToken: "sw-token",
  lunchMoneyApiKey: "lm-key",
};

// --- getUserShare ---

describe("getUserShare", () => {
  it("returns positive amount when user owes money", () => {
    const expense = makeExpense({
      users: [{ user_id: 123, net_balance: "-10.00" }],
    });
    expect(getUserShare(expense, "123")).toBe(10);
  });

  it("returns negative amount when user is owed money", () => {
    const expense = makeExpense({
      users: [{ user_id: 123, net_balance: "15.50" }],
    });
    expect(getUserShare(expense, "123")).toBe(-15.5);
  });

  it("returns null when user is not in the expense", () => {
    const expense = makeExpense({
      users: [{ user_id: 456, net_balance: "-10.00" }],
    });
    expect(getUserShare(expense, "123")).toBeNull();
  });

  it("returns null when user balance is zero", () => {
    const expense = makeExpense({
      users: [{ user_id: 123, net_balance: "0" }],
    });
    expect(getUserShare(expense, "123")).toBeNull();
  });
});

// --- planSync (via syncLink dry run) ---

describe("syncLink dry run", () => {
  let db: UserDb;

  type LinkInsert = typeof userSchema.links.$inferInsert;

  async function insertLink(
    overrides: Partial<LinkInsert> = {},
  ): Promise<typeof userSchema.links.$inferSelect> {
    const [row] = await db
      .insert(userSchema.links)
      .values({
        lmAccountId: 100,
        lastSyncedAt: "2024-01-01T00:00:00Z",
        ...overrides,
      })
      .returning();
    return row;
  }

  beforeEach(async () => {
    db = createTestDb();
    await initUserDb(db);
    mockGetExpenses.mockReset().mockResolvedValue(fetched([]));
    mockGetTransactions.mockReset().mockResolvedValue([]);
    mockGetCategories.mockReset().mockResolvedValue([]);
  });

  it("creates a transaction for a new expense", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(fetched([makeExpense({ id: 1001 })]));

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.created).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions![0]).toMatchObject({
      type: "create",
      expenseId: "1001",
      amount: 10,
      payee: "Test expense",
    });
  });

  it("skips an expense that is already synced and unchanged", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
    });

    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, updated_at: "2024-06-15T12:00:00Z" })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("updates a transaction when the expense has been modified", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
    });

    mockGetExpenses.mockResolvedValue(
      fetched([
        makeExpense({
          id: 1001,
          updated_at: "2024-06-16T08:00:00Z",
          cost: "30.00",
        }),
      ]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.updated).toBe(1);
    expect(result.actions![0]).toMatchObject({
      type: "update",
      expenseId: "1001",
    });
  });

  it("deletes a tracked expense that was deleted in Splitwise", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
    });

    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, deleted_at: "2024-06-16T00:00:00Z" })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.deleted).toBe(1);
    expect(result.actions![0]).toMatchObject({
      type: "delete",
      expenseId: "1001",
    });
  });

  it("ignores a deleted expense that was already marked deleted", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
      isDeleted: 1,
    });

    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, deleted_at: "2024-06-16T00:00:00Z" })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("ignores a deleted expense that was never tracked", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 9999, deleted_at: "2024-06-16T00:00:00Z" })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("skips expenses before start_date", async () => {
    const link = await insertLink({ startDate: "2024-07-01" });
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, date: "2024-06-15T00:00:00Z" })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("skips payments when includePayments is off", async () => {
    const link = await insertLink({ includePayments: 0 });
    mockGetExpenses.mockResolvedValue(fetched([makeExpense({ id: 1001, payment: true })]));

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("includes payments with prefix when includePayments is on", async () => {
    const link = await insertLink({ includePayments: 1 });
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, payment: true, description: "Settlement" })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.created).toBe(1);
    expect(result.actions![0].payee).toBe("Splitwise Payment: Settlement");
  });

  it("skips expenses where user has no share", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(
      fetched([
        makeExpense({
          id: 1001,
          users: [{ user_id: 456, net_balance: "-10.00" }],
        }),
      ]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("carries splitwiseUpdatedAt from the expense", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, updated_at: "2024-06-15T12:00:00Z" })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].splitwiseUpdatedAt).toBe("2024-06-15T12:00:00Z");
  });

  it("includes category in notes", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, category: { id: 5, name: "Groceries" } })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.notes).toContain("Groceries");
  });

  it("sets category_id when Splitwise category matches LM category by name", async () => {
    const link = await insertLink();
    mockGetCategories.mockResolvedValue([
      { id: 42, name: "Groceries", is_group: false },
      { id: 43, name: "Rent", is_group: false },
    ]);
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, category: { id: 5, name: "Groceries" } })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.category_id).toBe(42);
  });

  it("matches category via stemming (plural to singular)", async () => {
    const link = await insertLink();
    mockGetCategories.mockResolvedValue([{ id: 42, name: "Grocery", is_group: false }]);
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, category: { id: 5, name: "Groceries" } })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.category_id).toBe(42);
  });

  it("does not set category_id when no LM category matches", async () => {
    const link = await insertLink();
    mockGetCategories.mockResolvedValue([{ id: 42, name: "Entertainment", is_group: false }]);
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, category: { id: 5, name: "Groceries" } })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.category_id).toBeUndefined();
  });

  it("skips category groups when matching", async () => {
    const link = await insertLink();
    mockGetCategories.mockResolvedValue([{ id: 42, name: "Groceries", is_group: true }]);
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 1001, category: { id: 5, name: "Groceries" } })]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.category_id).toBeUndefined();
  });

  it("does not set category_id on updates", async () => {
    const link = await insertLink();
    await db.insert(syncedTransactions).values({
      linkId: link.id,
      splitwiseExpenseId: "1001",
      lmTransactionId: 5000,
      splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
    });
    mockGetCategories.mockResolvedValue([{ id: 42, name: "Groceries", is_group: false }]);
    mockGetExpenses.mockResolvedValue(
      fetched([
        makeExpense({
          id: 1001,
          updated_at: "2024-06-16T08:00:00Z",
          category: { id: 5, name: "Groceries" },
        }),
      ]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].type).toBe("update");
    expect(result.actions![0].lmData.category_id).toBeUndefined();
  });

  it("includes total in notes when user share differs from total", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(
      fetched([
        makeExpense({
          id: 1001,
          cost: "30.00",
          users: [{ user_id: 123, net_balance: "-10.00" }],
        }),
      ]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.notes).toContain("Total: USD 30.00");
  });

  it("classifies a mix of expenses correctly in one sync", async () => {
    const link = await insertLink();
    // Seed tracked rows for expenses that already exist
    await db.insert(syncedTransactions).values([
      {
        linkId: link.id,
        splitwiseExpenseId: "2001",
        lmTransactionId: 5001,
        splitwiseUpdatedAt: "2024-06-10T00:00:00Z",
      },
      {
        linkId: link.id,
        splitwiseExpenseId: "3001",
        lmTransactionId: 5002,
        splitwiseUpdatedAt: "2024-06-10T00:00:00Z",
      },
      {
        linkId: link.id,
        splitwiseExpenseId: "5001",
        lmTransactionId: 5003,
        splitwiseUpdatedAt: "2024-06-15T12:00:00Z",
      },
    ]);

    mockGetExpenses.mockResolvedValue(
      fetched([
        // New expense → create
        makeExpense({ id: 1001 }),
        // Modified expense → update
        makeExpense({ id: 2001, updated_at: "2024-06-20T00:00:00Z" }),
        // Deleted expense → delete
        makeExpense({ id: 3001, deleted_at: "2024-06-18T00:00:00Z" }),
        // User has no share → skip
        makeExpense({
          id: 4001,
          users: [{ user_id: 456, net_balance: "-5.00" }],
        }),
        // Already synced, unchanged → skip
        makeExpense({ id: 5001, updated_at: "2024-06-15T12:00:00Z" }),
      ]),
    );

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.expenses_fetched).toBe(5);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.actions).toHaveLength(3);

    const types = result.actions!.map((a) => `${a.type}:${a.expenseId}`);
    expect(types).toContain("create:1001");
    expect(types).toContain("update:2001");
    expect(types).toContain("delete:3001");
  });

  describe("backfill on first sync", () => {
    it("does not re-create expenses that already exist in LM", async () => {
      const link = await insertLink({ lastSyncedAt: null });
      mockGetTransactions.mockResolvedValue([{ id: 5000, external_id: "1001" }]);
      mockGetExpenses.mockResolvedValue(fetched([makeExpense({ id: 1001 })]));

      const result = await syncLink(db, link, defaultUser, { dryRun: true });

      expect(result.created).toBe(0);
      // An update is expected: the backfilled row has splitwiseUpdatedAt=""
      // so the expense's real updated_at triggers a harmless update.
      expect(result.actions!.every((a) => a.type !== "create")).toBe(true);
    });

    it("ignores LM transactions with non-numeric external_id", async () => {
      const link = await insertLink({ lastSyncedAt: null });
      mockGetTransactions.mockResolvedValue([{ id: 5000, external_id: "not-a-number" }]);
      mockGetExpenses.mockResolvedValue(fetched([makeExpense({ id: 1001 })]));

      const result = await syncLink(db, link, defaultUser, { dryRun: true });

      expect(result.created).toBe(1);
    });
  });
});

// --- syncLink execute path ---

describe("syncLink execute", () => {
  let db: UserDb;

  type LinkInsert = typeof userSchema.links.$inferInsert;

  async function insertLink(
    overrides: Partial<LinkInsert> = {},
  ): Promise<typeof userSchema.links.$inferSelect> {
    const [row] = await db
      .insert(userSchema.links)
      .values({
        lmAccountId: 100,
        lastSyncedAt: "2024-01-01T00:00:00Z",
        ...overrides,
      })
      .returning();
    return row;
  }

  async function insertTracked(linkId: number, expenseId: string, lmTransactionId: number) {
    await db.insert(syncedTransactions).values({
      linkId,
      splitwiseExpenseId: expenseId,
      lmTransactionId,
      splitwiseUpdatedAt: "2024-06-01T00:00:00Z",
    });
  }

  async function trackedRow(linkId: number, expenseId: string) {
    const [row] = await db
      .select()
      .from(syncedTransactions)
      .where(eq(syncedTransactions.linkId, linkId));
    expect(row.splitwiseExpenseId).toBe(expenseId);
    return row;
  }

  beforeEach(async () => {
    db = createTestDb();
    await initUserDb(db);
    mockGetExpenses.mockReset().mockResolvedValue(fetched([]));
    mockGetTransactions.mockReset().mockResolvedValue([]);
    mockInsertTransactions
      .mockReset()
      .mockResolvedValue({ transactions: [], skippedDuplicates: [] });
    mockUpdateTransactions.mockReset().mockResolvedValue({ missingIds: [] });
    mockGetCategories.mockReset().mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates sync_log with status=success on successful sync", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(fetched([makeExpense({ id: 1001 })]));
    mockInsertTransactions.mockResolvedValue({
      transactions: [{ id: 9001, external_id: "1001" }],
      skippedDuplicates: [],
    });

    const result = await syncLink(db, link, defaultUser);

    expect(result.created).toBe(1);

    const logs = await db.select().from(syncLog).where(eq(syncLog.linkId, link.id));
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("success");
    expect(logs[0].created).toBe(1);
    expect(logs[0].finishedAt).toBeTruthy();
  });

  it("records status=error with message when execute fails", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(fetched([makeExpense({ id: 1001 })]));
    mockInsertTransactions.mockRejectedValue(new Error("LM API down"));

    await expect(syncLink(db, link, defaultUser)).rejects.toThrow("LM API down");

    const logs = await db.select().from(syncLog).where(eq(syncLog.linkId, link.id));
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].errorMessage).toContain("LM API down");
  });

  it("logs a planning failure and records it in sync_log", async () => {
    const link = await insertLink();
    mockGetExpenses.mockRejectedValue(new Error("Splitwise API error (502)"));

    await expect(syncLink(db, link, defaultUser)).rejects.toThrow("Splitwise API error (502)");

    const logs = await db.select().from(syncLog).where(eq(syncLog.linkId, link.id));
    expect(logs).toEqual([
      expect.objectContaining({
        status: "error",
        errorMessage: expect.stringContaining("Splitwise API error (502)"),
        finishedAt: expect.any(String),
        expensesFetched: 0,
        created: 0,
        updated: 0,
        deleted: 0,
      }),
    ]);
    expect(loggedErrors()).toEqual([{ msg: "Sync failed", linkId: link.id }]);
  });

  it.each([
    {
      service: "Lunch Money",
      reject: () => mockGetCategories.mockRejectedValue(lunchMoneyRejection()),
      warning: "Sync failed: Lunch Money rejected the user's API key",
    },
    {
      service: "Splitwise",
      reject: () => mockGetExpenses.mockRejectedValue(splitwiseRejection()),
      warning: "Sync failed: Splitwise rejected the user's access token",
    },
  ])("logs $service rejecting a credential as a warning and records it", async (c) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const link = await insertLink();
    c.reject();

    await expect(syncLink(db, link, defaultUser)).rejects.toThrow("API error (401)");

    const logs = await db.select().from(syncLog).where(eq(syncLog.linkId, link.id));
    expect(logs).toEqual([
      expect.objectContaining({
        status: "error",
        errorMessage: expect.stringContaining(`${c.service} API error (401)`),
      }),
    ]);
    expect(loggedErrors()).toEqual([]);
    expect(loggedWarnings()).toEqual([c.warning]);
  });

  it("leaves no trace of a failed dry run", async () => {
    const link = await insertLink();
    mockGetExpenses.mockRejectedValue(new Error("Splitwise API error (401)"));

    await expect(syncLink(db, link, defaultUser, { dryRun: true })).rejects.toThrow(
      "Splitwise API error (401)",
    );

    expect(await db.select().from(syncLog)).toEqual([]);
    expect(loggedErrors()).toEqual([]);
  });

  it("updates lastSyncedAt cursor on success", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(fetched([]));

    await syncLink(db, link, defaultUser);

    const [updated] = await db.select().from(links).where(eq(links.id, link.id));
    expect(updated.lastSyncedAt).toBeTruthy();
    expect(updated.lastSyncedAt).not.toBe(link.lastSyncedAt);
  });

  it("writes tracking rows to synced_transactions for created expenses", async () => {
    const link = await insertLink();
    mockGetExpenses.mockResolvedValue(
      fetched([makeExpense({ id: 2001 }), makeExpense({ id: 2002 })]),
    );
    mockInsertTransactions.mockResolvedValue({
      transactions: [
        { id: 9001, external_id: "2001" },
        { id: 9002, external_id: "2002" },
      ],
      skippedDuplicates: [],
    });

    await syncLink(db, link, defaultUser);

    const tracked = await db
      .select()
      .from(syncedTransactions)
      .where(eq(syncedTransactions.linkId, link.id));
    expect(tracked).toHaveLength(2);
    const expenseIds = tracked.map((t) => t.splitwiseExpenseId).sort();
    expect(expenseIds).toEqual(["2001", "2002"]);
  });

  describe("when the request budget runs out", () => {
    beforeEach(() => {
      mockGetExpenses.mockResolvedValue(fetched([makeExpense({ id: 1001 })]));
      mockInsertTransactions.mockResolvedValue({
        transactions: [{ id: 9001, external_id: "1001" }],
        skippedDuplicates: [],
      });
    });

    it.each([
      [
        "planning",
        () => {
          mockGetExpenses.mockImplementation(exhaustRequestBudget);
          return insertLink();
        },
      ],
      [
        "writing to Lunch Money",
        () => {
          mockInsertTransactions.mockImplementation(exhaustRequestBudget);
          return insertLink();
        },
      ],
      [
        "recording the changes",
        () => {
          vi.spyOn(db.$client, "batch").mockImplementation(exhaustRequestBudget);
          return insertLink();
        },
      ],
      [
        "stamping backfilled rows",
        () => {
          mockGetTransactions.mockResolvedValue([{ id: 5000, external_id: "1001", amount: "10" }]);
          vi.spyOn(db.$client, "batch").mockImplementation(exhaustRequestBudget);
          return insertLink({ lastSyncedAt: null });
        },
      ],
    ])("while %s, rethrows without logging or writing sync_log", async (_, setUp) => {
      const link = await setUp();

      await expect(withRequestBudget(() => syncLink(db, link, defaultUser))).rejects.toBeInstanceOf(
        RequestBudgetExceededError,
      );

      expect(loggedErrors()).toEqual([]);
      const logs = await db.select().from(syncLog);
      expect(logs.map((row) => row.status)).toEqual(["running"]);
    });
  });

  describe("when the LM transaction has been deleted", () => {
    it("stops tracking an edited expense instead of failing the sync", async () => {
      const link = await insertLink();
      await insertTracked(link.id, "3001", 9001);
      mockGetExpenses.mockResolvedValue(
        fetched([makeExpense({ id: 3001, updated_at: "2024-06-15T12:00:00Z" })]),
      );
      mockUpdateTransactions.mockResolvedValue({ missingIds: [9001] });

      const result = await syncLink(db, link, defaultUser);

      expect(result.updated).toBe(0);
      const row = await trackedRow(link.id, "3001");
      expect(row.isDeleted).toBe(1);
      expect(row.splitwiseUpdatedAt).toBe("2024-06-15T12:00:00Z");
      const [log] = await db.select().from(syncLog).where(eq(syncLog.linkId, link.id));
      expect(log.status).toBe("success");
      expect(log.updated).toBe(0);
    });

    it("marks a deleted expense as deleted without zeroing it out", async () => {
      const link = await insertLink();
      await insertTracked(link.id, "3002", 9002);
      mockGetExpenses.mockResolvedValue(
        fetched([makeExpense({ id: 3002, deleted_at: "2024-06-16T00:00:00Z" })]),
      );
      mockUpdateTransactions.mockResolvedValue({ missingIds: [9002] });

      const result = await syncLink(db, link, defaultUser);

      expect(result.deleted).toBe(0);
      const row = await trackedRow(link.id, "3002");
      expect(row.isDeleted).toBe(1);
      const [log] = await db.select().from(syncLog).where(eq(syncLog.linkId, link.id));
      expect(log.status).toBe("success");
      expect(log.deleted).toBe(0);
    });

    it("does not re-plan the expense on the next sync", async () => {
      const link = await insertLink();
      await insertTracked(link.id, "3003", 9003);
      mockGetExpenses.mockResolvedValue(
        fetched([makeExpense({ id: 3003, updated_at: "2024-06-15T12:00:00Z" })]),
      );
      mockUpdateTransactions.mockResolvedValue({ missingIds: [9003] });
      await syncLink(db, link, defaultUser);

      const [synced] = await db.select().from(links).where(eq(links.id, link.id));
      const result = await syncLink(db, synced, defaultUser, { dryRun: true });

      expect(result.actions).toEqual([]);
    });

    it("still applies the other updates in the batch", async () => {
      const link = await insertLink();
      await insertTracked(link.id, "3004", 9004);
      await insertTracked(link.id, "3005", 9005);
      mockGetExpenses.mockResolvedValue(
        fetched([
          makeExpense({ id: 3004, updated_at: "2024-06-15T12:00:00Z" }),
          makeExpense({ id: 3005, updated_at: "2024-06-15T12:00:00Z" }),
        ]),
      );
      mockUpdateTransactions.mockResolvedValue({ missingIds: [9004] });

      const result = await syncLink(db, link, defaultUser);

      expect(result.updated).toBe(1);
      const rows = await db
        .select()
        .from(syncedTransactions)
        .where(eq(syncedTransactions.linkId, link.id))
        .orderBy(syncedTransactions.splitwiseExpenseId);
      expect(rows.map((r) => [r.splitwiseExpenseId, r.isDeleted, r.splitwiseUpdatedAt])).toEqual([
        ["3004", 1, "2024-06-15T12:00:00Z"],
        ["3005", 0, "2024-06-15T12:00:00Z"],
      ]);
    });
  });
});

// --- syncLink over several runs ---

function expenseListing(count: number) {
  return Array.from({ length: count }, (_, i) => makeExpense({ id: 1001 + i }));
}

function createdExpenseIds(): string[] {
  return mockInsertTransactions.mock.calls.flatMap(([, txs]) =>
    (txs as { external_id: string }[]).map((tx) => tx.external_id),
  );
}

describe("syncLink catching up", () => {
  const PAGE = EXPENSE_PAGE_SIZE;
  const perRun = EXPENSE_PAGES_PER_RUN * PAGE;
  let db: UserDb;

  function serveListing(listing: SplitwiseExpense[], pageSize = PAGE) {
    mockGetExpenses.mockImplementation(
      async (_token: string, { offset = 0, maxPages }: { offset?: number; maxPages: number }) => {
        const end = offset + maxPages * pageSize;
        const expenses = listing.slice(offset, end);
        return fetched(expenses, expenses.length === maxPages * pageSize ? end : null);
      },
    );
  }

  async function addLink(values: Partial<typeof links.$inferInsert> = {}) {
    const [row] = await db
      .insert(links)
      .values({ lmAccountId: 100, ...values })
      .returning();
    return row;
  }

  async function linkRow(id: number) {
    const [row] = await db.select().from(links).where(eq(links.id, id));
    return row;
  }

  // a sync started at `at`, of the link as the database has it, as the cron would run it
  async function runAt(at: string, linkId: number) {
    vi.setSystemTime(new Date(at));
    return syncLink(db, await linkRow(linkId), defaultUser);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    db = createTestDb();
    await initUserDb(db);
    mockGetExpenses.mockReset();
    mockGetTransactions.mockReset().mockResolvedValue([]);
    mockGetCategories.mockReset().mockResolvedValue([]);
    mockInsertTransactions
      .mockReset()
      .mockImplementation(async (_key: string, txs: { external_id: string }[]) => ({
        transactions: txs.map((tx) => ({
          id: 9000 + Number(tx.external_id),
          external_id: tx.external_id,
        })),
        skippedDuplicates: [],
      }));
    mockUpdateTransactions.mockReset().mockResolvedValue({ missingIds: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spreads a first sync too large for one run over several runs", async () => {
    const link = await addLink({ startDate: "2020-01-01" });
    serveListing(expenseListing(2 * perRun + 3));

    expect(await runAt("2026-10-23T10:00:00.000Z", link.id)).toMatchObject({
      created: perRun,
      more_to_sync: true,
    });
    expect(await linkRow(link.id)).toMatchObject({
      lastSyncedAt: null,
      catchUpOffset: perRun,
      catchUpStartedAt: "2026-10-23T10:00:00.000Z",
    });

    expect(await runAt("2026-10-23T12:00:00.000Z", link.id)).toMatchObject({
      created: perRun - CATCH_UP_OVERLAP,
      more_to_sync: true,
    });
    expect(await linkRow(link.id)).toMatchObject({
      lastSyncedAt: null,
      catchUpOffset: 2 * perRun - CATCH_UP_OVERLAP,
      catchUpStartedAt: "2026-10-23T10:00:00.000Z",
    });

    expect(await runAt("2026-10-23T14:00:00.000Z", link.id)).toMatchObject({
      created: 3 + CATCH_UP_OVERLAP,
      more_to_sync: false,
    });
    expect(await linkRow(link.id)).toMatchObject({
      lastSyncedAt: "2026-10-23T10:00:00.000Z",
      catchUpOffset: null,
      catchUpStartedAt: null,
    });

    expect(mockGetExpenses.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ updated_after: "2020-01-01", offset: 0 }),
      expect.objectContaining({ updated_after: "2020-01-01", offset: perRun - CATCH_UP_OVERLAP }),
      expect.objectContaining({
        updated_after: "2020-01-01",
        offset: 2 * perRun - 2 * CATCH_UP_OVERLAP,
      }),
    ]);
    const created = createdExpenseIds();
    expect(created).toHaveLength(2 * perRun + 3);
    expect(new Set(created).size).toBe(created.length);
    const logs = await db.select().from(syncLog);
    expect(logs.map((row) => row.status)).toEqual(["success", "success", "success"]);
    expect(mockGetTransactions).toHaveBeenCalledTimes(1);

    // the next sync covers everything updated since the catch-up started
    serveListing([]);
    await runAt("2026-10-23T16:00:00.000Z", link.id);
    expect(mockGetExpenses).toHaveBeenLastCalledWith(
      "sw-token",
      expect.objectContaining({ updated_after: "2026-10-23T09:58:00.000Z", offset: 0 }),
    );
  });

  it("holds updated_after through a catch-up after earlier syncs", async () => {
    const link = await addLink({ lastSyncedAt: "2026-09-01T00:00:00.000Z" });
    serveListing(expenseListing(perRun + 1));

    await runAt("2026-10-23T10:00:00.000Z", link.id);
    expect(await linkRow(link.id)).toMatchObject({
      lastSyncedAt: "2026-09-01T00:00:00.000Z",
      catchUpOffset: perRun,
    });
    await runAt("2026-10-23T12:00:00.000Z", link.id);

    expect(
      mockGetExpenses.mock.calls.map(([, params]) => [params.updated_after, params.offset]),
    ).toEqual([
      ["2026-08-31T23:58:00.000Z", 0],
      ["2026-08-31T23:58:00.000Z", perRun - CATCH_UP_OVERLAP],
    ]);
    expect(await linkRow(link.id)).toMatchObject({
      lastSyncedAt: "2026-10-23T10:00:00.000Z",
      catchUpOffset: null,
    });
    expect(createdExpenseIds()).toHaveLength(perRun + 1);
  });

  it.each([
    {
      change: "is redated behind the bookmark",
      updated: 1,
      shift: (listing: SplitwiseExpense[], moved: SplitwiseExpense) => [
        ...listing.filter((e) => e !== moved),
        { ...moved, date: "2019-06-15T00:00:00Z", updated_at: "2026-10-23T11:00:00Z" },
      ],
    },
    {
      change: "leaves the listing",
      updated: 0,
      shift: (listing: SplitwiseExpense[], moved: SplitwiseExpense) =>
        listing.filter((e) => e !== moved),
    },
  ])(
    "still creates the expense at the bookmark when one already fetched $change",
    async ({ shift, updated }) => {
      const link = await addLink();
      const listing = expenseListing(perRun + 10);
      const atBookmark = listing[perRun];
      serveListing(listing);
      await runAt("2026-10-23T10:00:00.000Z", link.id);
      expect(await linkRow(link.id)).toMatchObject({ catchUpOffset: perRun });

      // everything after the moved expense shifts up one, putting atBookmark just before the bookmark
      serveListing(shift(listing, listing[5]));
      expect(await runAt("2026-10-23T12:00:00.000Z", link.id)).toMatchObject({
        created: 10,
        updated,
        more_to_sync: false,
      });

      const created = createdExpenseIds();
      expect(created).toContain(String(atBookmark.id));
      expect(created.sort()).toEqual(listing.map((e) => String(e.id)).sort());
    },
  );

  it("gives backfilled transactions the decisions one run would, whichever run reaches them", async () => {
    // Lunch Money already has the last two expenses, one at Splitwise's amount and one not
    const listing = expenseListing(2 * perRun + 2);
    const [matching, drifted] = listing.slice(-2);
    mockGetTransactions.mockResolvedValue([
      { id: 501, external_id: String(matching.id), amount: "10.0000" },
      { id: 502, external_id: String(drifted.id), amount: "12.5000" },
    ]);

    async function syncUntilDone(pageSize: number) {
      db = createTestDb();
      await initUserDb(db);
      mockInsertTransactions.mockClear();
      mockUpdateTransactions.mockClear();
      mockGetTransactions.mockClear();
      serveListing(listing, pageSize);
      let link = await addLink();
      let runs = 0;
      while (!link.lastSyncedAt && runs < 10) {
        await syncLink(db, link, defaultUser);
        runs++;
        link = await linkRow(link.id);
      }
      return {
        runs,
        backfills: mockGetTransactions.mock.calls.length,
        created: createdExpenseIds().sort(),
        updated: mockUpdateTransactions.mock.calls.flatMap(([, updates]) =>
          (updates as { id: number }[]).map((u) => u.id),
        ),
        tracked: await db
          .select({
            expenseId: syncedTransactions.splitwiseExpenseId,
            lmTransactionId: syncedTransactions.lmTransactionId,
            splitwiseUpdatedAt: syncedTransactions.splitwiseUpdatedAt,
            isDeleted: syncedTransactions.isDeleted,
          })
          .from(syncedTransactions)
          .orderBy(syncedTransactions.splitwiseExpenseId),
      };
    }

    const oneRun = await syncUntilDone(listing.length);
    const severalRuns = await syncUntilDone(PAGE);

    expect(oneRun.runs).toBe(1);
    expect(oneRun.updated).toEqual([502]);
    expect(oneRun.tracked).toContainEqual(
      expect.objectContaining({
        expenseId: String(matching.id),
        splitwiseUpdatedAt: matching.updated_at,
      }),
    );
    expect(severalRuns).toEqual({ ...oneRun, runs: 3 });
  });

  it("dry-runs the next run's share of a catch-up", async () => {
    const listing = expenseListing(2 * perRun + 1);
    const drifted = listing[perRun];
    mockGetTransactions.mockResolvedValue([
      { id: 502, external_id: String(drifted.id), amount: "12.5000" },
    ]);
    const link = await addLink();
    serveListing(listing);
    await syncLink(db, link, defaultUser);

    const plan = await syncLink(db, await linkRow(link.id), defaultUser, { dryRun: true });

    expect(mockGetExpenses).toHaveBeenLastCalledWith(
      "sw-token",
      expect.objectContaining({ offset: perRun - CATCH_UP_OVERLAP }),
    );
    expect(mockGetTransactions).toHaveBeenCalledTimes(1);
    expect(plan).toMatchObject({
      expenses_fetched: perRun,
      created: perRun - CATCH_UP_OVERLAP - 1,
      updated: 1,
      more_to_sync: true,
    });
    expect(await linkRow(link.id)).toMatchObject({ catchUpOffset: perRun });
  });

  it.each([
    ["Lunch Money fails", () => mockInsertTransactions.mockRejectedValue(new Error("LM API down"))],
    [
      "the request budget runs out",
      () => vi.spyOn(db.$client, "batch").mockImplementation(exhaustRequestBudget),
    ],
  ])("leaves the bookmark where it was when %s", async (_, fail) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const link = await addLink({
      catchUpOffset: perRun,
      catchUpStartedAt: "2026-10-23T10:00:00.000Z",
    });
    serveListing(expenseListing(3 * perRun));
    fail();

    await expect(withRequestBudget(() => syncLink(db, link, defaultUser))).rejects.toThrow();

    expect(await linkRow(link.id)).toMatchObject({
      lastSyncedAt: null,
      catchUpOffset: perRun,
      catchUpStartedAt: "2026-10-23T10:00:00.000Z",
    });
  });
});

// --- syncBalances ---

function makeGroup(id: number, balances: { currency: string; amount: string }[]): SplitwiseGroup {
  return {
    id,
    members: [
      {
        id: 123,
        balance: balances.map((b) => ({
          currency_code: b.currency,
          amount: b.amount,
        })),
      },
    ],
  } as SplitwiseGroup;
}

describe("syncBalances", () => {
  const rates: ExchangeRates = { USD: 1, EUR: 0.85, GBP: 0.73 };

  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), with: vi.fn() };

  beforeEach(() => {
    mockGetUser.mockReset().mockResolvedValue({ primary_currency: "usd" });
    mockUpdateAccountBalance.mockReset().mockResolvedValue(void 0);
    mockGetGroup.mockReset().mockResolvedValue(null);
    mockGetGroups.mockReset().mockResolvedValue([]);
    log.debug.mockClear();
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
  });

  it("syncs a single group, single currency balance", async () => {
    const link = makeLink({ splitwiseGroupId: "10" });
    mockGetGroup.mockResolvedValue(makeGroup(10, [{ currency: "USD", amount: "25.50" }]));

    await syncBalances([link], defaultUser, rates, log);

    expect(mockUpdateAccountBalance).toHaveBeenCalledWith("lm-key", 100, 25.5);
  });

  it("converts and sums multi-currency balances", async () => {
    const link = makeLink({ splitwiseGroupId: "10" });
    // 10 EUR + 20 USD. EUR->USD: 10 / 0.85 * 1 = 11.7647...
    mockGetGroup.mockResolvedValue(
      makeGroup(10, [
        { currency: "EUR", amount: "10.00" },
        { currency: "USD", amount: "20.00" },
      ]),
    );

    await syncBalances([link], defaultUser, rates, log);

    const balance = mockUpdateAccountBalance.mock.calls[0][2] as number;
    // 10 / 0.85 + 20 = 31.7647...
    expect(balance).toBeCloseTo(convertCurrency(10, "EUR", "USD", rates) + 20, 3);
  });

  it("deduplicates group IDs across multiple links", async () => {
    // Two links both covering group 10 (one specific, one all-groups)
    const link1 = makeLink({ id: 1, splitwiseGroupId: "10", lmAccountId: 100 });
    const link2 = makeLink({ id: 2, splitwiseGroupId: null, lmAccountId: 100 });
    const group = makeGroup(10, [{ currency: "USD", amount: "50.00" }]);

    mockGetGroup.mockResolvedValue(group);
    mockGetGroups.mockResolvedValue([group]);

    await syncBalances([link1, link2], defaultUser, rates, log);

    // Should only count group 10 once, not twice
    expect(mockUpdateAccountBalance).toHaveBeenCalledTimes(1);
    expect(mockUpdateAccountBalance).toHaveBeenCalledWith("lm-key", 100, 50);
  });

  it("isolates per-account errors", async () => {
    const link1 = makeLink({ id: 1, splitwiseGroupId: "10", lmAccountId: 100 });
    const link2 = makeLink({ id: 2, splitwiseGroupId: "20", lmAccountId: 200 });

    mockGetGroup.mockImplementation((_token: string, groupId: number) => {
      if (groupId === 10) throw new Error("API error");
      return makeGroup(20, [{ currency: "USD", amount: "30.00" }]);
    });

    await syncBalances([link1, link2], defaultUser, rates, log);

    // Account 100 failed, but account 200 should still sync
    expect(mockUpdateAccountBalance).toHaveBeenCalledTimes(1);
    expect(mockUpdateAccountBalance).toHaveBeenCalledWith("lm-key", 200, 30);
    expect(log.error).toHaveBeenCalled();
  });

  it("logs a rejected key as a fingerprinted warning", async () => {
    const link = makeLink({ splitwiseGroupId: "10" });
    mockGetGroup.mockResolvedValue(makeGroup(10, [{ currency: "USD", amount: "25.50" }]));
    mockUpdateAccountBalance.mockRejectedValue(lunchMoneyRejection());

    await syncBalances([link], defaultUser, rates, log);

    expect(log.warn).toHaveBeenCalledWith(
      "Balance sync failed for account: Lunch Money rejected the user's API key",
      expect.objectContaining({ accountId: 100 }),
      { fingerprint: ["sync-credential-rejected", "lunch-money-key"] },
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("skips links with syncBalance=0", async () => {
    const link = makeLink({ syncBalance: 0 });

    await syncBalances([link], defaultUser, rates, log);

    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockUpdateAccountBalance).not.toHaveBeenCalled();
  });

  it("stops at the first account once the request budget runs out", async () => {
    const link1 = makeLink({ id: 1, splitwiseGroupId: "10", lmAccountId: 100 });
    const link2 = makeLink({ id: 2, splitwiseGroupId: "20", lmAccountId: 200 });
    mockGetGroup.mockImplementation(exhaustRequestBudget);

    await expect(
      withRequestBudget(() => syncBalances([link1, link2], defaultUser, rates, log)),
    ).rejects.toBeInstanceOf(RequestBudgetExceededError);

    expect(mockGetGroup).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe("syncUser", () => {
  const rates: ExchangeRates = { USD: 1 };
  let userDb: UserDb;

  async function addLink(overrides: Partial<typeof links.$inferInsert> = {}) {
    const [row] = await userDb
      .insert(links)
      .values({ splitwiseGroupId: "10", lmAccountId: 100, ...overrides })
      .returning();
    return row;
  }

  async function syncLogStatuses(): Promise<Record<number, string[]>> {
    const rows = await userDb.select().from(syncLog);
    const byLink: Record<number, string[]> = {};
    for (const row of rows) {
      (byLink[row.linkId] ??= []).push(row.status);
    }
    return byLink;
  }

  beforeEach(async () => {
    env.ENCRYPTION_KEYS = JSON.stringify({ "1": btoa("k".repeat(32)) });

    const shared = drizzle({ client: createClient({ url: ":memory:" }), schema: sharedSchema });
    await shared.run(sql`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        splitwise_user_id TEXT NOT NULL UNIQUE,
        turso_db_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await shared.insert(sharedSchema.users).values([
      { id: 1, splitwiseUserId: "123", tursoDbUrl: "libsql://user-1.example" },
      { id: 2, splitwiseUserId: "456", tursoDbUrl: null },
    ]);

    userDb = createTestDb();
    await initUserDb(userDb);
    await userDb.insert(credentials).values({
      splitwiseAccessToken: await encrypt("sw-token"),
      lunchMoneyApiKey: await encrypt("lm-key"),
    });

    vi.mocked(getSharedDb)
      .mockReset()
      .mockReturnValue(shared as SharedDb);
    vi.mocked(getUserDb).mockReset().mockReturnValue(userDb);
    mockGetExpenses.mockReset().mockResolvedValue(fetched([]));
    mockGetTransactions.mockReset().mockResolvedValue([]);
    mockGetCategories.mockReset().mockResolvedValue([]);
    mockGetGroup.mockReset().mockResolvedValue(makeGroup(10, [{ currency: "USD", amount: "5" }]));
    mockGetUser.mockReset().mockResolvedValue({ primary_currency: "usd" });
    mockUpdateAccountBalance.mockReset().mockResolvedValue(void 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs each enabled link, then balances", async () => {
    const first = await addLink({ syncBalance: 1 });
    const second = await addLink({ splitwiseGroupId: "20" });
    await addLink({ enabled: 0 });

    await syncUser(1, rates);

    expect(vi.mocked(getUserDb)).toHaveBeenCalledWith("libsql://user-1.example");
    expect(mockGetExpenses).toHaveBeenCalledWith("sw-token", expect.anything());
    expect(await syncLogStatuses()).toEqual({
      [first.id]: ["success"],
      [second.id]: ["success"],
    });
    expect(mockUpdateAccountBalance).toHaveBeenCalledWith("lm-key", 100, 5);
  });

  it("skips balance sync without exchange rates", async () => {
    await addLink({ syncBalance: 1 });

    await syncUser(1, null);

    expect(mockUpdateAccountBalance).not.toHaveBeenCalled();
  });

  it("marks runs left in progress as interrupted", async () => {
    const link = await addLink({ enabled: 0 });
    await userDb.insert(syncLog).values({ linkId: link.id, startedAt: "2026-01-01T00:00:00Z" });

    await syncUser(1, rates);

    const [row] = await userDb.select().from(syncLog);
    expect(row).toMatchObject({ status: "error", errorMessage: "Process interrupted" });
  });

  it("records a failed link and moves on to the next", async () => {
    const first = await addLink();
    const second = await addLink({ splitwiseGroupId: "20" });
    mockGetExpenses.mockRejectedValueOnce(new Error("Splitwise is down"));

    await syncUser(1, rates);

    expect(mockGetExpenses).toHaveBeenCalledTimes(2);
    expect(await syncLogStatuses()).toEqual({
      [first.id]: ["error"],
      [second.id]: ["success"],
    });
  });

  it("logs a rejected Lunch Money key as warnings, not errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const link = await addLink({ syncBalance: 1 });
    mockGetCategories.mockRejectedValue(lunchMoneyRejection());
    mockGetUser.mockRejectedValue(lunchMoneyRejection());

    await syncUser(1, rates);

    expect(await syncLogStatuses()).toEqual({ [link.id]: ["error"] });
    expect(loggedErrors()).toEqual([]);
    expect(loggedWarnings()).toEqual([
      "Sync failed: Lunch Money rejected the user's API key",
      "Balance sync failed: Lunch Money rejected the user's API key",
    ]);
  });

  it("throws when the user's setup fails, so the queue retries it", async () => {
    userDb.$client.close();

    await expect(syncUser(1, rates)).rejects.toThrow();
  });

  it("stops at the first link once the request budget runs out", async () => {
    await addLink();
    await addLink({ splitwiseGroupId: "20" });
    mockGetExpenses.mockImplementation(exhaustRequestBudget);

    await expect(withRequestBudget(() => syncUser(1, rates))).rejects.toBeInstanceOf(
      RequestBudgetExceededError,
    );

    expect(mockGetExpenses).toHaveBeenCalledTimes(1);
  });

  it("stops when the request budget runs out during balance sync", async () => {
    await addLink({ syncBalance: 1 });
    mockGetUser.mockImplementation(exhaustRequestBudget);

    await expect(withRequestBudget(() => syncUser(1, rates))).rejects.toBeInstanceOf(
      RequestBudgetExceededError,
    );
  });

  it("skips a user without a Lunch Money API key", async () => {
    await addLink();
    await userDb.update(credentials).set({ lunchMoneyApiKey: null });

    await syncUser(1, rates);

    expect(mockGetExpenses).not.toHaveBeenCalled();
  });

  it.each([
    ["has no database", 2],
    ["no longer exists", 3],
  ])("skips a user who %s", async (_, userId) => {
    await syncUser(userId, rates);

    expect(vi.mocked(getUserDb)).not.toHaveBeenCalled();
  });
});

// These tests validate that the raw SQL strings in executeActions() and api.tsx
// match the actual schema created by initUserDb(). If a column is renamed in
// the Drizzle schema, these fail with "no such column" at CI time.
describe("raw SQL schema consistency", () => {
  let db: UserDb;

  beforeEach(async () => {
    db = createTestDb();
    await initUserDb(db);
    // Insert prerequisite rows for FK constraints
    await db.insert(userSchema.credentials).values({
      splitwiseAccessToken: "tok",
    });
    await db.insert(links).values({
      lmAccountId: 100,
    });
  });

  it("INSERT into synced_transactions matches schema", async () => {
    const client = db.$client;
    await client.execute({
      sql: "INSERT INTO synced_transactions (link_id, splitwise_expense_id, lm_transaction_id, splitwise_updated_at) VALUES (?, ?, ?, ?)",
      args: [1, "exp_1", 999, "2024-01-01T00:00:00Z"],
    });
    const rows = await db.select().from(syncedTransactions);
    expect(rows).toHaveLength(1);
    expect(rows[0].splitwiseExpenseId).toBe("exp_1");
  });

  it("UPDATE synced_transactions (update pattern) matches schema", async () => {
    await db.insert(syncedTransactions).values({
      linkId: 1,
      splitwiseExpenseId: "exp_1",
      lmTransactionId: 999,
      splitwiseUpdatedAt: "2024-01-01T00:00:00Z",
    });
    const client = db.$client;
    await client.execute({
      sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, is_deleted = 0, updated_at = datetime('now') WHERE id = ?",
      args: ["2024-02-01T00:00:00Z", 1],
    });
    const rows = await db.select().from(syncedTransactions).where(eq(syncedTransactions.id, 1));
    expect(rows[0].splitwiseUpdatedAt).toBe("2024-02-01T00:00:00Z");
  });

  it("UPDATE synced_transactions (delete pattern) matches schema", async () => {
    await db.insert(syncedTransactions).values({
      linkId: 1,
      splitwiseExpenseId: "exp_1",
      lmTransactionId: 999,
      splitwiseUpdatedAt: "2024-01-01T00:00:00Z",
    });
    const client = db.$client;
    await client.execute({
      sql: "UPDATE synced_transactions SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?",
      args: [1],
    });
    const rows = await db.select().from(syncedTransactions).where(eq(syncedTransactions.id, 1));
    expect(rows[0].isDeleted).toBe(1);
  });

  it("UPDATE synced_transactions (stop tracking pattern) matches schema", async () => {
    await db.insert(syncedTransactions).values({
      linkId: 1,
      splitwiseExpenseId: "exp_1",
      lmTransactionId: 999,
      splitwiseUpdatedAt: "2024-01-01T00:00:00Z",
    });
    const client = db.$client;
    await client.execute({
      sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, is_deleted = 1, updated_at = datetime('now') WHERE id = ?",
      args: ["2024-02-01T00:00:00Z", 1],
    });
    const rows = await db.select().from(syncedTransactions).where(eq(syncedTransactions.id, 1));
    expect(rows[0].splitwiseUpdatedAt).toBe("2024-02-01T00:00:00Z");
    expect(rows[0].isDeleted).toBe(1);
  });

  it("UPDATE synced_transactions (stamp pattern) matches schema", async () => {
    await db.insert(syncedTransactions).values({
      linkId: 1,
      splitwiseExpenseId: "exp_1",
      lmTransactionId: 999,
      splitwiseUpdatedAt: "2024-01-01T00:00:00Z",
    });
    const client = db.$client;
    await client.execute({
      sql: "UPDATE synced_transactions SET splitwise_updated_at = ?, updated_at = datetime('now') WHERE id = ?",
      args: ["2024-03-01T00:00:00Z", 1],
    });
    const rows = await db.select().from(syncedTransactions).where(eq(syncedTransactions.id, 1));
    expect(rows[0].splitwiseUpdatedAt).toBe("2024-03-01T00:00:00Z");
  });

  it("DELETE FROM synced_transactions WHERE link_id matches schema", async () => {
    await db.insert(syncedTransactions).values({
      linkId: 1,
      splitwiseExpenseId: "exp_1",
      lmTransactionId: 999,
      splitwiseUpdatedAt: "2024-01-01T00:00:00Z",
    });
    const client = db.$client;
    await client.execute({
      sql: "DELETE FROM synced_transactions WHERE link_id = ?",
      args: [1],
    });
    const rows = await db.select().from(syncedTransactions);
    expect(rows).toHaveLength(0);
  });

  it("DELETE FROM sync_log WHERE link_id matches schema", async () => {
    await db.insert(syncLog).values({
      linkId: 1,
      startedAt: "2024-01-01T00:00:00Z",
    });
    const client = db.$client;
    await client.execute({
      sql: "DELETE FROM sync_log WHERE link_id = ?",
      args: [1],
    });
    const rows = await db.select().from(syncLog);
    expect(rows).toHaveLength(0);
  });

  it("DELETE FROM links WHERE id matches schema", async () => {
    const client = db.$client;
    await client.execute({
      sql: "DELETE FROM links WHERE id = ?",
      args: [1],
    });
    const rows = await db.select().from(links);
    expect(rows).toHaveLength(0);
  });
});
