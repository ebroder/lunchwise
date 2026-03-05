import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as userSchema from "./schema-user.js";
import { syncedTransactions, syncLog, links } from "./schema-user.js";
import { initUserDb, type UserDb } from "./db.js";
import { syncLink, syncBalances } from "./sync.js";
import {
  getUserShare,
  getAllExpenses,
  getGroups,
  getGroup,
  type SplitwiseExpense,
  type SplitwiseGroup,
} from "./splitwise.js";
import {
  getTransactions,
  insertTransactions,
  updateTransactions,
  getUser,
  updateAccountBalance,
} from "./lunch-money.js";
import { convertCurrency, type ExchangeRates } from "./exchange-rates.js";
import type { User } from "./auth.js";

vi.mock("./splitwise.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./splitwise.js")>();
  return {
    ...mod,
    getAllExpenses: vi.fn().mockResolvedValue([]),
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
    updateTransactions: vi.fn().mockResolvedValue(void 0),
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

const mockGetAllExpenses = getAllExpenses as Mock;
const mockGetTransactions = getTransactions as Mock;
const mockInsertTransactions = insertTransactions as Mock;
const mockUpdateTransactions = updateTransactions as Mock;
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
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

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
    mockGetAllExpenses.mockReset().mockResolvedValue([]);
    mockGetTransactions.mockReset().mockResolvedValue([]);
  });

  it("creates a transaction for a new expense", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);

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

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, updated_at: "2024-06-15T12:00:00Z" }),
    ]);

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

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({
        id: 1001,
        updated_at: "2024-06-16T08:00:00Z",
        cost: "30.00",
      }),
    ]);

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

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, deleted_at: "2024-06-16T00:00:00Z" }),
    ]);

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

    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, deleted_at: "2024-06-16T00:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("ignores a deleted expense that was never tracked", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 9999, deleted_at: "2024-06-16T00:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("skips expenses before start_date", async () => {
    const link = await insertLink({ startDate: "2024-07-01" });
    mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001, date: "2024-06-15T00:00:00Z" })]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("skips payments when includePayments is off", async () => {
    const link = await insertLink({ includePayments: 0 });
    mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001, payment: true })]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("includes payments with prefix when includePayments is on", async () => {
    const link = await insertLink({ includePayments: 1 });
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, payment: true, description: "Settlement" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.created).toBe(1);
    expect(result.actions![0].payee).toBe("Splitwise Payment: Settlement");
  });

  it("skips expenses where user has no share", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({
        id: 1001,
        users: [{ user_id: 456, net_balance: "-10.00" }],
      }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions).toHaveLength(0);
  });

  it("carries splitwiseUpdatedAt from the expense", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, updated_at: "2024-06-15T12:00:00Z" }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].splitwiseUpdatedAt).toBe("2024-06-15T12:00:00Z");
  });

  it("includes category in notes", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({ id: 1001, category: { id: 5, name: "Groceries" } }),
    ]);

    const result = await syncLink(db, link, defaultUser, { dryRun: true });

    expect(result.actions![0].lmData.notes).toContain("Groceries");
  });

  it("includes total in notes when user share differs from total", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([
      makeExpense({
        id: 1001,
        cost: "30.00",
        users: [{ user_id: 123, net_balance: "-10.00" }],
      }),
    ]);

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

    mockGetAllExpenses.mockResolvedValue([
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
    ]);

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
      mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);

      const result = await syncLink(db, link, defaultUser, { dryRun: true });

      expect(result.created).toBe(0);
      // An update is expected: the backfilled row has splitwiseUpdatedAt=""
      // so the expense's real updated_at triggers a harmless update.
      expect(result.actions!.every((a) => a.type !== "create")).toBe(true);
    });

    it("ignores LM transactions with non-numeric external_id", async () => {
      const link = await insertLink({ lastSyncedAt: null });
      mockGetTransactions.mockResolvedValue([{ id: 5000, external_id: "not-a-number" }]);
      mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);

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

  beforeEach(async () => {
    db = createTestDb();
    await initUserDb(db);
    mockGetAllExpenses.mockReset().mockResolvedValue([]);
    mockGetTransactions.mockReset().mockResolvedValue([]);
    mockInsertTransactions
      .mockReset()
      .mockResolvedValue({ transactions: [], skippedDuplicates: [] });
    mockUpdateTransactions.mockReset().mockResolvedValue(void 0);
  });

  it("creates sync_log with status=success on successful sync", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);
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
    mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 1001 })]);
    mockInsertTransactions.mockRejectedValue(new Error("LM API down"));

    await expect(syncLink(db, link, defaultUser)).rejects.toThrow("LM API down");

    const logs = await db.select().from(syncLog).where(eq(syncLog.linkId, link.id));
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].errorMessage).toContain("LM API down");
  });

  it("updates lastSyncedAt cursor on success", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([]);

    await syncLink(db, link, defaultUser);

    const [updated] = await db.select().from(links).where(eq(links.id, link.id));
    expect(updated.lastSyncedAt).toBeTruthy();
    expect(updated.lastSyncedAt).not.toBe(link.lastSyncedAt);
  });

  it("writes tracking rows to synced_transactions for created expenses", async () => {
    const link = await insertLink();
    mockGetAllExpenses.mockResolvedValue([makeExpense({ id: 2001 }), makeExpense({ id: 2002 })]);
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
});

// --- syncBalances ---

describe("syncBalances", () => {
  const rates: ExchangeRates = { USD: 1, EUR: 0.85, GBP: 0.73 };

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

  it("skips links with syncBalance=0", async () => {
    const link = makeLink({ syncBalance: 0 });

    await syncBalances([link], defaultUser, rates, log);

    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockUpdateAccountBalance).not.toHaveBeenCalled();
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
